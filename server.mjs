#!/usr/bin/env node
// 클로드 타운: ~/.claude 의 세션 상태를 읽어 픽셀 사무실로 보여주는 로컬 서버.
// 의존성 없음. 127.0.0.1 에만 열리고, 읽기만 한다(~/.claude 에 아무것도 쓰지 않는다).
import http from 'node:http'
import { readFile, readdir, stat, open } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const PORT = Number(process.env.PORT) || 4777
const HERE = path.dirname(fileURLToPath(import.meta.url))
const TAIL_BYTES = 96 * 1024
const ACTIVE_MS = 15 * 1000
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

  // 도구 호출은 끝난 뒤에야 기록되므로 "실행 중" 은 알 수 없다. 가장 최근에 쓴 도구만 알려준다.
  const value = { tool: null, at: st.mtimeMs }
  const lines = buf.toString('utf8').split('\n')
  for (let i = lines.length - 1; i >= 0 && !value.tool; i--) {
    let row
    try {
      row = JSON.parse(lines[i])
    } catch {
      continue
    }
    if (row.isSidechain || row.type !== 'assistant') continue
    const content = row?.message?.content
    if (!Array.isArray(content)) continue
    value.tool = content.findLast((b) => b.type === 'tool_use')?.name ?? null
  }
  toolCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value })
  return value
}

const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')
const transcriptOf = (cwd, sessionId) => path.join(CLAUDE_DIR, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)

function placeOf(cwd = '') {
  const marker = '/.claude/worktrees/'
  const at = cwd.indexOf(marker)
  if (at === -1) return { project: path.basename(cwd), worktree: null }
  return { project: path.basename(cwd.slice(0, at)), worktree: cwd.slice(at + marker.length) }
}

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
    const activity = job.state === 'working' ? await lastActivity(file) : null
    out.push({
      id: job.daemonShort || job.sessionId,
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
      tool: activity?.tool ?? null,
      phase: phaseOf(activity),
    })
  }

  // 백그라운드 작업이 아닌, 터미널에서 직접 연 대화형 세션.
  for (const proc of procs) {
    if (usedPids.has(proc.pid) || proc.kind !== 'interactive') continue
    const activity = await lastActivity(transcriptOf(proc.cwd || '', proc.sessionId))
    const recent = activity && Date.now() - activity.at < 5 * 60 * 1000
    out.push({
      id: `pid-${proc.pid}`,
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
    })
  }
  return { now: Date.now(), sessions: out }
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
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500).end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`클로드 타운이 열렸습니다: http://localhost:${PORT}`)
})
