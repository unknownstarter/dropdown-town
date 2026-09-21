#!/usr/bin/env node
// Dropdown Town: ~/.claude 의 세션 상태를 읽어 픽셀 사무실로 보여주는 로컬 서버.
// 의존성 없음. 127.0.0.1 에만 열린다. ~/.claude 는 읽기만 하고, 세션 제어는 공식 claude 명령만 부른다.
import http from 'node:http'
import { readFile, readdir, stat, open } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const PORT = Number(process.env.PORT) || 4777
const HERE = path.dirname(fileURLToPath(import.meta.url))
const TAIL_BYTES = 96 * 1024
const ACTIVE_MS = 15 * 1000
const SUB_ACTIVE_MS = 90 * 1000
const phaseOf = (activity) => (activity ? (Date.now() - activity.at < ACTIVE_MS ? 'tool' : 'thinking') : null)

// state.json 은 데몬이 수시로 덮어쓴다. 쓰는 도중에 읽어 파싱이 깨지면 직전 값을 쓴다.
const lastGood = new Map()
async function readJson(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'))
    lastGood.set(file, value)
    return value
  } catch {
    return lastGood.get(file) ?? null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// 트랜스크립트 끝부분만 읽어 최근에 쓴 도구와 마지막 기록 시각을 알아낸다.
const toolCache = new Map()
async function lastActivity(file) {
  const st = await stat(file).catch(() => null)
  if (!st) return null
  const cached = toolCache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.value

  const len = Math.min(st.size, TAIL_BYTES)
  const fh = await open(file, 'r')
  const buf = Buffer.alloc(len)
  await fh.read(buf, 0, len, st.size - len)
  await fh.close()

  // 끝에서부터 거슬러 올라가며 찾는다: 최근에 쓴 도구, 권한 모드, 세션이 마지막으로 한 말, 허락을 기다리는 도구.
  // 도구 호출은 보통 끝난 뒤에야 기록되므로 "실행 중" 은 알 수 없고, 맨 끝에 결과 없는 도구 호출이 남아 있을 때만 대기 중으로 본다.
  const value = { tool: null, at: st.mtimeMs, mode: null, lastText: null, pending: null }
  const lines = buf.toString('utf8').split('\n')
  let sawTurn = false
  for (let i = lines.length - 1; i >= 0 && !(value.tool && value.mode && value.lastText); i--) {
    let row
    try {
      row = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (row.type === 'permission-mode' && !value.mode) value.mode = row.permissionMode || null
    if (row.isSidechain) continue
    const content = row?.message?.content
    if (!Array.isArray(content)) continue
    if (row.type === 'assistant') {
      const use = content.findLast((b) => b.type === 'tool_use')
      const text = content.findLast((b) => b.type === 'text' && b.text?.trim())
      if (use && !value.tool) {
        value.tool = use.name
        if (!sawTurn) value.pending = { name: use.name, what: String(use.input?.description || use.input?.command || use.input?.file_path || '').slice(0, 300) }
      }
      if (text && !value.lastText) value.lastText = text.text.trim().slice(-1500)
      sawTurn = true
    } else if (row.type === 'user') sawTurn = true
  }
  toolCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

// 세션이 부른 서브에이전트. 기록 파일이 최근까지 쓰이고 있으면 일하는 중으로 본다.
async function subagentsOf(transcript) {
  const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents')
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl'))
  const out = []
  for (const f of files) {
    const st = await stat(path.join(dir, f)).catch(() => null)
    if (!st || Date.now() - st.mtimeMs > SUB_ACTIVE_MS) continue
    const meta = (await readJson(path.join(dir, f.replace(/\.jsonl$/, '.meta.json')))) || {}
    out.push({ id: f.slice(6, -6), type: meta.agentType || 'agent', description: meta.description || '', at: st.mtimeMs })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 6)
}

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const transcriptOf = (cwd, sessionId) => path.join(CLAUDE_DIR, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)

function placeOf(cwd = '') {
  const marker = '/.claude/worktrees/'
  const at = cwd.indexOf(marker)
  if (at === -1) return { project: path.basename(cwd), worktree: null }
  return { project: path.basename(cwd.slice(0, at)), worktree: cwd.slice(at + marker.length) }
}

// 세션 제어가 확인에 쓰는 장부: 새 세션을 열 수 있는 폴더(세션이 돌았던 프로젝트만)와 세션별 최신 상태.
const knownDirs = new Set()
const jobStates = new Map()

async function collect() {
  const jobsDir = path.join(CLAUDE_DIR, 'jobs')
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions')

  const sessionFiles = (await readdir(sessionsDir).catch(() => [])).filter((f) => f.endsWith('.json'))
  const procs = (await Promise.all(sessionFiles.map((f) => readJson(path.join(sessionsDir, f)))))
    .filter(Boolean)
    .map((p) => ({ ...p, alive: isAlive(p.pid) }))
    .filter((p) => p.alive)

  const jobIds = await readdir(jobsDir).catch(() => [])
  const jobs = (await Promise.all(jobIds.map((id) => readJson(path.join(jobsDir, id, 'state.json'))))).filter(Boolean)

  const out = []
  const usedPids = new Set()
  for (const job of jobs) {
    const proc = procs.find((p) => p.sessionId === job.sessionId) || procs.find((p) => p.kind === 'bg' && p.name === job.name)
    if (proc) usedPids.add(proc.pid)
    const cwd = proc?.cwd || job.cwd || job.originCwd || ''
    const file = job.linkScanPath || transcriptOf(job.originCwd || cwd, job.sessionId)
    const activity = await lastActivity(file)
    const working = job.state === 'working'
    if (job.originCwd) knownDirs.add(job.originCwd)
    if (job.daemonShort) jobStates.set(job.daemonShort, job.state)
    const subagents = job.state === 'working' ? await subagentsOf(file) : []
    out.push({
      id: job.daemonShort || job.sessionId,
      subagents,
      kind: 'bg',
      name: job.name || job.daemonShort,
      state: job.state,
      detail: job.detail || '',
      intent: (job.intent || '').slice(0, 400),
      tokens: job.tokens || 0,
      ...placeOf(cwd),
      createdAt: Date.parse(job.createdAt) || null,
      updatedAt: Date.parse(job.updatedAt) || null,
      helpers: job.inFlight?.tasks || 0,
      helperKinds: job.inFlight?.kinds || [],
      links: (job.children || []).filter((c) => c.href).map((c) => ({ kind: c.kind, id: c.id, href: c.href })),
      alive: Boolean(proc),
      tool: working ? (activity?.tool ?? null) : null,
      phase: working ? phaseOf(activity) : null,
      permissionMode: activity?.mode ?? null,
      lastText: activity?.lastText ?? null,
      pending: job.state === 'blocked' ? (activity?.pending ?? null) : null,
      result: typeof job.output === 'string' ? job.output.slice(0, 600) : null,
    })
  }

  // 백그라운드 작업이 아닌, 터미널에서 직접 연 대화형 세션.
  for (const proc of procs) {
    if (usedPids.has(proc.pid) || proc.kind !== 'interactive') continue
    const activity = await lastActivity(transcriptOf(proc.cwd || '', proc.sessionId))
    const recent = activity && Date.now() - activity.at < 5 * 60 * 1000
    out.push({
      id: `pid-${proc.pid}`,
      subagents: [],
      kind: 'interactive',
      name: proc.name || `pid ${proc.pid}`,
      state: proc.status === 'busy' && recent ? 'working' : 'idle',
      detail: '',
      intent: '',
      tokens: 0,
      ...placeOf(proc.cwd),
      createdAt: proc.startedAt || null,
      updatedAt: activity?.at || proc.updatedAt || null,
      helpers: 0,
      helperKinds: [],
      links: [],
      alive: true,
      tool: recent ? activity.tool : null,
      phase: recent ? phaseOf(activity) : null,
      permissionMode: activity?.mode ?? null,
    })
  }
  return { now: Date.now(), sessions: out, dirs: [...knownDirs].sort() }
}

/* ---------- 세션 제어 ---------- */
// 전부 Claude Code 의 공식 명령(claude stop / rm / --bg / attach)을 그대로 부른다. 내부 파일이나 소켓은 건드리지 않는다.
// 안전 장치: (1) 서버가 뜰 때 만든 토큰을 화면에만 심어 두고 요청 헤더로 요구한다(다른 웹페이지는 이 헤더를 못 보낸다),
// (2) id 는 지금 장부에 있는 세션이어야 하고 상태가 맞아야 한다, (3) 셸을 거치지 않고 인자 배열로 실행한다.
const TOKEN = randomBytes(18).toString('hex')
const claudeBin = [path.join(path.dirname(process.execPath), 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local/bin/claude')].find((f) => existsSync(f)) || 'claude'
const childEnv = { ...process.env, NO_COLOR: '1', PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` }
const run = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: 30000, env: childEnv, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-800) }))
})
const hasState = (id, states) => /^[0-9a-f]{8}$/.test(id || '') && states.includes(jobStates.get(id))
const ACTIONS = {
  // 작업실이나 호출 구역의 세션을 멈춘다. 대화는 보존되어 나중에 이어 갈 수 있다.
  stop: ({ id }) => (hasState(id, ['working', 'blocked']) ? run(claudeBin, ['stop', id]) : null),
  // 휴게실의 끝났거나 멈춘 세션을 지운다. push 안 된 커밋이 있는 워크트리는 claude rm 이 스스로 거부한다.
  remove: ({ id }) => (hasState(id, ['done', 'stopped']) ? run(claudeBin, ['rm', id]) : null),
  // 새 백그라운드 세션. 폴더는 이미 세션이 돌았던 프로젝트 중에서만 고른다.
  start: ({ cwd, prompt }) => (knownDirs.has(cwd) && typeof prompt === 'string' && prompt.trim() ? run(claudeBin, ['--bg', prompt.trim().slice(0, 4000)], { cwd }) : null),
  // 터미널 앱에서 그 세션을 연다. 권한 요청에 대한 수락과 거절은 거기서 직접 한다.
  attach: ({ id }) => (hasState(id, ['working', 'blocked', 'done', 'stopped']) && !/["\\$`]/.test(claudeBin)
    ? run('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "'${claudeBin}' attach ${id}"`, '-e', 'tell application "Terminal" to activate'])
    : null),
}
async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 20000) throw new Error('too large')
  }
  return JSON.parse(raw || '{}')
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' }

const server = http.createServer(async (req, res) => {
  // DNS 리바인딩 방지: 로컬 호스트 이름으로 온 요청만 받는다.
  const host = (req.headers.host || '').split(':')[0]
  if (host !== 'localhost' && host !== '127.0.0.1') {
    res.writeHead(403).end()
    return
  }
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname.startsWith('/api/action/')) {
      const action = ACTIONS[url.pathname.slice('/api/action/'.length)]
      if (req.method !== 'POST' || !action || req.headers['x-town-token'] !== TOKEN) {
        res.writeHead(403).end()
        return
      }
      const result = await action(await readBody(req))
      res.writeHead(result ? 200 : 400, { 'content-type': TYPES['.json'] })
      res.end(JSON.stringify(result || { ok: false, output: '지금 상태에서는 할 수 없는 요청이에요' }))
      return
    }
    if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
      res.end(JSON.stringify(await collect()))
      return
    }
    const rel = url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^[/\\]+/, '')
    const file = path.join(HERE, rel)
    const allowed = file === path.join(HERE, 'index.html') || file.startsWith(path.join(HERE, 'assets') + path.sep)
    if (!allowed) {
      res.writeHead(404).end()
      return
    }
    let body = await readFile(file)
    if (rel === 'index.html') body = body.toString('utf8').replace('__TOWN_TOKEN__', TOKEN)
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500).end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Dropdown Town 이 열렸습니다: http://localhost:${PORT}`)
})
