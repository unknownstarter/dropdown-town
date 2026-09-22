#!/usr/bin/env node
// Dropdown Town: ~/.claude 의 세션 상태를 읽어 픽셀 사무실로 보여주는 로컬 서버.
// 의존성 없음. 127.0.0.1 에만 열린다. ~/.claude 는 읽기만 하고, 세션 제어는 공식 claude 명령만 부른다.
import http from 'node:http'
import { readFile, readdir, stat, open, realpath, mkdir, writeFile } from 'node:fs/promises'
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
// sidechain: 조수 기록은 모든 행에 사이드체인 표시가 있어 그대로 읽는다.
// deep: 끝난 세션은 파일 끝에 큰 첨부 행이 몰려 마지막 답이 꼬리 밖에 있을 수 있으므로, 못 찾으면 파일 전체(최대 32MB)를 읽어 다시 찾는다.
async function lastActivity(file, sidechain = false, deep = false) {
  const st = await stat(file).catch(() => null)
  if (!st) return null
  const cached = toolCache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && (!deep || cached.deep)) return cached.value
  const msgs = await scanMessages(file, st)

  const len = Math.min(st.size, deep ? 32 * 1024 * 1024 : TAIL_BYTES)
  const fh = await open(file, 'r')
  const buf = Buffer.alloc(len)
  await fh.read(buf, 0, len, st.size - len)
  await fh.close()

  // 끝에서부터 거슬러 올라가며 찾는다: 최근에 쓴 도구, 권한 모드, 세션이 마지막으로 한 말, 허락을 기다리는 도구.
  // 도구 호출은 보통 끝난 뒤에야 기록되므로 "실행 중" 은 알 수 없고, 맨 끝에 결과 없는 도구 호출이 남아 있을 때만 대기 중으로 본다.
  const value = { tool: null, at: st.mtimeMs, mode: null, lastText: null, pending: null, received: msgs.received, sent: msgs.sent, talks: msgs.history.map(({ key, ...h }) => h) }
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
    if (row.isSidechain && !sidechain) continue
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
  toolCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value, deep })
  return value
}

// 세션끼리 주고받은 메시지는 기록 어디에나 있을 수 있어서(도구 결과가 크면 꼬리 밖으로 밀린다) 마지막으로 읽은 위치부터 이어서 훑는다.
// 처음 보는 파일은 끝 96KB 부터 시작하고, 다른 세션이나 조수가 보낸 메시지(사용자 행의 <agent-message from=...>)와
// 이 세션이 SendMessage 로 보낸 메시지를 각각 가장 최근 것 하나만 기억한다.
const msgCache = new Map()
// 행 안 어딘가에 들어 있는 받은 메시지 원문을 찾는다(user 행은 content 글자, attachment 행은 더 깊은 곳에 있다).
function findTagged(v, depth = 0) {
  if (typeof v === 'string') return v.includes('<agent-message from=') ? v : null
  if (!v || typeof v !== 'object' || depth > 6) return null
  for (const x of Array.isArray(v) ? v : Object.values(v)) { const hit = findTagged(x, depth + 1); if (hit) return hit }
  return null
}
// 받은 메시지에서 사람이 읽을 본문만 남긴다: 앞뒤 틀 문구와 들여쓰기를 걷어내고 공백을 한 칸으로.
function messageBody(raw) {
  let body = raw.slice(raw.indexOf('>', raw.indexOf('<agent-message from=')) + 1)
  body = body.split('</agent-message>')[0]
  body = body.replace(/\[Subagent hand-back\][\s\S]*?The report follows:/, '').replace(/\s+/g, ' ').trim()
  return body.slice(0, 280)
}
const pushTalk = (c, entry) => { // 같은 메시지가 여러 행(대기열, 첨부)에 되풀이되므로 상대와 앞부분이 같으면 한 번만 둔다
  const key = `${entry.dir}|${entry.peer}|${entry.text.slice(0, 60)}`
  if (c.history.some((h) => h.key === key)) return
  c.history.push({ ...entry, key })
  if (c.history.length > 8) c.history.shift()
}
async function scanMessages(file, st) {
  const c = msgCache.get(file) || { offset: Math.max(0, st.size - TAIL_BYTES), received: null, sent: null, history: [] }
  if (st.size > c.offset) {
    const len = Math.min(st.size - c.offset, 4 * 1024 * 1024)
    const fh = await open(file, 'r'), buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, c.offset)
    await fh.close()
    const text = buf.toString('utf8'), cut = text.lastIndexOf('\n')
    for (const line of text.slice(0, cut).split('\n')) {
      if (!line.includes('agent-message from=') && !line.includes('"SendMessage"')) continue
      let row
      try { row = JSON.parse(line) } catch { continue }
      const content = row?.message?.content, at = Date.parse(row.timestamp) || st.mtimeMs
      if (row.type !== 'assistant' && line.includes('agent-message from=')) { // 받은 메시지는 user, attachment, queue-operation 등 여러 종류의 행에 실린다
        const m = line.match(/<agent-message from=\\?"([A-Za-z0-9._-]+)\\?"/) // 식별자 글자만 허용해 코드 조각 같은 것을 메시지로 오인하지 않게
        if (!m) continue
        const handback = line.includes('[Subagent hand-back]'), raw = findTagged(row) || ''
        c.received = { from: m[1], at, handback }
        pushTalk(c, { dir: 'in', peer: m[1], at, handback, text: raw ? messageBody(raw) : '' })
      } else if (row.type === 'assistant' && Array.isArray(content)) {
        for (const msg of content.filter((b) => b.type === 'tool_use' && b.name === 'SendMessage')) {
          const to = String(msg.input?.to || '').slice(0, 80), text = String(msg.input?.summary || msg.input?.message || '').replace(/\s+/g, ' ').trim().slice(0, 280)
          c.sent = { to, at }
          pushTalk(c, { dir: 'out', peer: to, at, handback: false, text })
        }
      }
    }
    c.offset += cut + 1
  }
  msgCache.set(file, c)
  return c
}

// 기록 파일 첫 줄의 사용자 메시지 = 그 세션(조수)이 받은 지시문. 바뀌지 않으므로 한 번만 읽는다.
const headCache = new Map()
async function instructionOf(file) {
  if (headCache.has(file)) return headCache.get(file)
  let text = ''
  try {
    const fh = await open(file, 'r'), buf = Buffer.alloc(16 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    await fh.close()
    for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
      try { const row = JSON.parse(line); const c = row?.message?.content; if (row.type === 'user' && typeof c === 'string') { text = c.slice(0, 600); break } } catch {}
    }
  } catch {}
  if (text) headCache.set(file, text)
  return text
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
    const act = await lastActivity(path.join(dir, f), true)
    out.push({ id: f.slice(6, -6), type: meta.agentType || 'agent', description: meta.description || '', at: st.mtimeMs,
      tool: act?.tool ?? null, phase: phaseOf(act), lastText: act?.lastText ?? null, instruction: await instructionOf(path.join(dir, f)) })
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

// 새 세션이나 릴레이를 열 수 있는 폴더. 세션이 돌았던 프로젝트 말고도 같은 맥의 다른 프로젝트를 고를 수 있게,
// 흔한 프로젝트 폴더 모음(~/Documents/GitHub, ~/Projects 등) 바로 아래의 폴더를 후보로 올린다. 60초마다 다시 훑는다.
const PROJECT_ROOTS = ['Documents/GitHub', 'Documents/Projects', 'Projects', 'projects', 'dev', 'src', 'code', 'workspace', 'repos', 'git'].map((d) => path.join(os.homedir(), d))
let dirCache = { at: 0, value: [] }
async function projectDirs() {
  if (Date.now() - dirCache.at < 60000) return dirCache.value
  const found = new Set(knownDirs)
  for (const root of PROJECT_ROOTS) {
    for (const name of await readdir(root).catch(() => [])) {
      if (name.startsWith('.') || name === 'node_modules') continue
      const full = path.join(root, name)
      if ((await stat(full).catch(() => null))?.isDirectory()) found.add(full)
    }
  }
  dirCache = { at: Date.now(), value: [...found].sort() }
  return dirCache.value
}
// 직접 적어 넣은 폴더도 받되, 실제로 있는 폴더이고 홈 폴더 아래여야 한다(심볼릭 링크로 밖을 가리키는 것도 막는다).
async function allowedDir(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0')) return null
  try {
    const real = await realpath(cwd)
    if (!(await stat(real)).isDirectory()) return null
    const home = await realpath(os.homedir())
    return real === home || real.startsWith(home + path.sep) ? real : null
  } catch { return null }
}
const jobStates = new Map()

/* ---------- 직원 명부: 직군 에이전트 정의와 지금까지의 활동 ---------- */
// 정의는 ~/.claude/agents 와 각 프로젝트의 .claude/agents 의 *.md 머리말에서, 활동은 세션마다 남는 subagents/*.meta.json 에서 읽는다.
const ROSTER_TTL = 10 * 1000
let rosterCache = { at: 0, value: [] }
async function agentDefs() {
  const defs = new Map()
  const places = [[path.join(CLAUDE_DIR, 'agents'), 'user'], ...[...knownDirs].map((d) => [path.join(d, '.claude', 'agents'), 'project'])]
  for (const [dir, scope] of places) {
    for (const f of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.md'))) {
      const head = (await readFile(path.join(dir, f), 'utf8').catch(() => '')).slice(0, 4000)
      const name = head.match(/^name:\s*(.+)$/m)?.[1]?.trim() || f.replace(/\.md$/, '')
      if (!defs.has(name)) defs.set(name, { scope, description: (head.match(/^description:\s*(.+)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '').slice(0, 240) })
    }
  }
  return defs
}
function projectLabel(encoded) { // 폴더 이름은 경로의 / 를 - 로 바꾼 것이라 완벽히 되돌릴 수 없다. 아는 프로젝트와 맞춰 보고, 안 되면 끝부분만 쓴다.
  const base = encoded.split('--claude-worktrees-')[0]
  for (const d of knownDirs) if (encodeCwd(d) === base) return path.basename(d)
  return base.replace(encodeCwd(os.homedir()), '').replace(/^-+/, '') || base
}
async function roster(sessionNames, workingIds) {
  if (Date.now() - rosterCache.at < ROSTER_TTL) return rosterCache.value
  const defs = await agentDefs()
  const blank = (type, scope, description) => ({ type, scope, description, count: 0, lastAt: null, active: [], recent: [], byProject: {} })
  const agents = new Map([...defs].map(([type, d]) => [type, blank(type, d.scope, d.description)]))
  const root = path.join(CLAUDE_DIR, 'projects')
  for (const proj of await readdir(root).catch(() => [])) {
    for (const sess of await readdir(path.join(root, proj)).catch(() => [])) {
      if (sess.endsWith('.jsonl')) continue
      const dir = path.join(root, proj, sess, 'subagents')
      for (const f of (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.meta.json'))) {
        const meta = await readJson(path.join(dir, f))
        const st = await stat(path.join(dir, f.replace(/\.meta\.json$/, '.jsonl'))).catch(() => null)
        if (!meta || !st) continue
        const type = meta.agentType || 'agent'
        if (!agents.has(type)) agents.set(type, blank(type, 'builtin', ''))
        const a = agents.get(type), project = projectLabel(proj), sessionName = sessionNames.get(sess) || null
        a.count++
        a.byProject[project] = (a.byProject[project] || 0) + 1
        if (!a.lastAt || st.mtimeMs > a.lastAt) a.lastAt = st.mtimeMs
        a.recent.push({ description: (meta.description || '').slice(0, 160), at: st.mtimeMs, project, sessionName })
        if (workingIds.has(sess) && Date.now() - st.mtimeMs < SUB_ACTIVE_MS) a.active.push({ sessionName: sessionName || sess.slice(0, 8) })
      }
    }
  }
  const value = [...agents.values()]
    .map((a) => ({ ...a, recent: a.recent.sort((x, y) => y.at - x.at).slice(0, 8) }))
    .sort((x, y) => y.active.length - x.active.length || (y.lastAt || 0) - (x.lastAt || 0))
  rosterCache = { at: Date.now(), value }
  return value
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
    const working = job.state === 'working'
    const activity = await lastActivity(file, false, !working) // 일하는 중인 세션은 매번 바뀌므로 꼬리만, 끝나거나 멈춘 세션은 전체를 읽어 마지막 말을 찾는다
    if (job.originCwd) knownDirs.add(job.originCwd)
    if (job.daemonShort) jobStates.set(job.daemonShort, job.state)
    const subagents = job.state === 'working' ? await subagentsOf(file) : []
    out.push({
      id: job.daemonShort || job.sessionId,
      subagents,
      received: activity?.received ?? null,
      talks: activity?.talks ?? [],
      sent: activity?.sent ?? null,
      relay: relayInfo(job.daemonShort),
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

  // 백그라운드 작업이 아닌 세션: 터미널에서 직접 연 것, 그리고 데스크톱 앱 등 다른 곳에서 연 것(종류 이름을 가리지 않는다).
  for (const proc of procs) {
    if (usedPids.has(proc.pid) || proc.kind === 'bg') continue
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
  const sessionNames = new Map(jobs.map((j) => [j.sessionId, j.name || j.daemonShort]))
  const workingIds = new Set(jobs.filter((j) => j.state === 'working').map((j) => j.sessionId))
  return { now: Date.now(), sessions: out, dirs: await projectDirs(), recentDirs: [...knownDirs].sort(), home: os.homedir(), agents: await roster(sessionNames, workingIds), relay: relayPublic() }
}

/* ---------- 세션 제어 ---------- */
// 전부 Claude Code 의 공식 명령(claude stop / rm / --bg / attach)을 그대로 부른다. 내부 파일이나 소켓은 건드리지 않는다.
// 안전 장치: (1) 서버가 뜰 때 만든 토큰을 화면에만 심어 두고 요청 헤더로 요구한다(다른 웹페이지는 이 헤더를 못 보낸다),
// (2) id 는 지금 장부에 있는 세션이어야 하고 상태가 맞아야 한다, (3) 셸을 거치지 않고 인자 배열로 실행한다.
const TOKEN = randomBytes(18).toString('hex')
const claudeBin = [path.join(path.dirname(process.execPath), 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(os.homedir(), '.local/bin/claude')].find((f) => existsSync(f)) || 'claude'
const childEnv = { ...process.env, NO_COLOR: '1', PATH: `${path.dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}` }
const run = (file, args, opts = {}) => new Promise((resolve) => {
  execFile(file, args, { timeout: 30000, env: childEnv, ...opts }, (err, stdout, stderr) => {
    const output = `${stdout}${stderr}`.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-800)
    resolve({ ok: !err, output: err && !output ? `[${err.code || err.signal || err.message}]` : output }) // 출력 없이 실패하면 원인 코드라도 남긴다
  })
})
/* ---------- 릴레이: 자율 사무실 첫 버전 ---------- */
// 사람이 한 번 시작하면 단계마다 새 백그라운드 세션을 열고, 앞 단계의 마지막 말을 다음 단계 지시문에 넣어 넘긴다.
// 안전 장치: 한 번에 릴레이 하나, 최대 4단계, 어느 단계가 막히면(사람 필요) 기다리고, 언제든 멈출 수 있다.
const RELAY_MAX_STEPS = 4
let relay = null
const relayInfo = (id) => (relay && id && relay.jobs.includes(id) ? { name: relay.name, step: relay.jobs.indexOf(id) + 1, total: relay.steps.length, status: relay.status } : null)
const ACTIVE = ['running', 'blocked', 'review']
// 사람이 고칠 수 있는 첫 단계: 확인 대기 중이면 곧 시작할 단계부터, 진행 중이면 그다음 단계부터.
const firstEditable = () => (relay.status === 'review' ? relay.current : relay.current + 1)
const relayPublic = () => relay && {
  name: relay.name, status: relay.status, step: relay.current + 1, total: relay.steps.length, jobs: relay.jobs, log: relay.log.slice(-8), cwd: relay.cwd,
  steps: relay.steps, editableFrom: firstEditable(), review: relay.review, pauseNext: relay.pauseNext,
  handoff: relay.status === 'review' ? (relay.results[relay.current - 1] || '').slice(0, 8000) : null,
}
async function relayLaunch() {
  relay.launching = true
  try { await relayLaunchInner() } finally { relay.launching = false }
}
async function relayLaunchInner() {
  const i = relay.current, prev = relay.results[i - 1] || ''
  const step = relay.steps[i]
  const prompt = (step.includes('{{prev}}') ? step.replace(/\{\{prev\}\}/g, prev) : prev ? `${step}\n\n[앞 단계에서 넘어온 결과]\n${prev}` : step).slice(0, 12000)
  // 새 세션은 뜨는 데 30초 넘게 걸리기도 한다(특히 앱을 막 켠 직후). 짧은 제한으로 끊으면 SIGTERM 으로 실패한다.
  const out = await run(claudeBin, ['--bg', `[릴레이 ${relay.name} ${i + 1}/${relay.steps.length}] ${prompt}`], { cwd: relay.cwd, timeout: 180000 })
  const id = out.output.match(/\b[0-9a-f]{8}\b/)?.[0]
  if (!out.ok || !id) { relay.status = 'failed'; relay.log.push(`${i + 1}단계 시작 실패: ${out.output.slice(0, 120)}`); return }
  relay.jobs.push(id); relay.status = 'running'; relay.log.push(`${i + 1}단계 시작 (${id})`)
}
async function relayTick() {
  if (!relay || relay.launching || !['running', 'blocked'].includes(relay.status)) return
  const id = relay.jobs[relay.current]
  if (!id) return
  const job = await readJson(path.join(CLAUDE_DIR, 'jobs', id, 'state.json'))
  if (!job) return
  if (job.state === 'blocked' && relay.status !== 'blocked') { relay.status = 'blocked'; relay.log.push(`${relay.current + 1}단계가 답을 기다려요`) }
  if (job.state === 'working' && relay.status === 'blocked') relay.status = 'running'
  if (job.state === 'stopped' || job.state === 'failed') { relay.status = 'failed'; relay.log.push(`${relay.current + 1}단계가 멈춰서 릴레이를 끝냈어요`); return }
  if (job.state !== 'done') return
  const act = await lastActivity(job.linkScanPath || transcriptOf(job.originCwd || relay.cwd, job.sessionId), false, true)
  // 다음 단계에 넘기는 것은 앞 단계가 마지막으로 한 말 본문이다. 세션이 남기는 output 은 한 줄 요약이라("시 2편 완성" 처럼) 본문이 없을 때만 쓴다.
  const out = job.output && typeof job.output === 'object' ? (typeof job.output.result === 'string' ? job.output.result : JSON.stringify(job.output)) : job.output
  relay.results[relay.current] = act?.lastText || (typeof out === 'string' && out) || ''
  relay.log.push(`${relay.current + 1}단계 완료`)
  relay.current++
  if (relay.current >= relay.steps.length) { relay.status = 'done'; relay.log.push('릴레이 완료'); return }
  // 사람이 끼어들기로 했으면(단계마다 확인, 또는 이번 한 번만 멈춤) 다음 단계를 열기 전에 기다린다. 넘길 결과와 다음 지시문을 고칠 수 있다.
  if (relay.review || relay.pauseNext) { relay.pauseNext = false; relay.status = 'review'; relay.log.push(`${relay.current}단계 결과를 확인해 주세요`); return }
  await relayLaunch()
}
setInterval(() => relayTick().catch((err) => { if (relay) { relay.status = 'failed'; relay.log.push(String(err.message || err).slice(0, 120)) } }), 3000)

const cleanSteps = (steps) => (Array.isArray(steps) ? steps.map((x) => String(x || '').trim()).filter(Boolean).slice(0, RELAY_MAX_STEPS) : [])

const hasState = (id, states) => /^[0-9a-f]{8}$/.test(id || '') && states.includes(jobStates.get(id))
const ACTIONS = {
  // 작업실이나 호출 구역의 세션을 멈춘다. 대화는 보존되어 나중에 이어 갈 수 있다.
  stop: ({ id }) => (hasState(id, ['working', 'blocked']) ? run(claudeBin, ['stop', id]) : null),
  // 휴게실의 끝났거나 멈춘 세션을 지운다. push 안 된 커밋이 있는 워크트리는 claude rm 이 스스로 거부한다.
  remove: ({ id }) => (hasState(id, ['done', 'stopped']) ? run(claudeBin, ['rm', id]) : null),
  // 새 백그라운드 세션. 폴더는 이미 세션이 돌았던 프로젝트 중에서만 고른다.
  start: async ({ cwd, prompt }) => {
    const dir = await allowedDir(cwd)
    if (!dir || typeof prompt !== 'string' || !prompt.trim()) return null
    knownDirs.add(dir)
    return run(claudeBin, ['--bg', prompt.trim().slice(0, 4000)], { cwd: dir, timeout: 180000 })
  },
  // 터미널 앱에서 그 세션을 연다. 권한 요청에 대한 수락과 거절은 거기서 직접 한다.
  // 릴레이 시작: 프로젝트 하나, 단계 지시문 1~4개. 앞 단계 결과는 {{prev}} 자리에, 없으면 지시문 끝에 붙는다.
  relayStart: async ({ cwd, name, steps, review }) => {
    if (relay && ACTIVE.includes(relay.status)) return { ok: false, output: '이미 도는 릴레이가 있어요. 먼저 멈춰 주세요.' }
    const list = cleanSteps(steps), dir = await allowedDir(cwd)
    if (!dir || !list.length) return null
    knownDirs.add(dir)
    relay = { name: String(name || '릴레이').slice(0, 24), cwd: dir, steps: list, current: 0, jobs: [], results: [], status: 'starting', log: ['1단계를 시작하는 중'], startedAt: Date.now(), review: Boolean(review), pauseNext: false }
    relayLaunch() // 세션이 뜨는 데 시간이 걸리므로 기다리지 않고 답한다. 진행은 위쪽 표시에서 보인다.
    return { ok: true, output: '릴레이를 시작했어요. 1단계 세션이 뜨는 중이에요.' }
  },
  // 릴레이 멈춤: 지금 단계 세션을 멈추고 더 진행하지 않는다.
  relayStop: async () => {
    if (!relay) return { ok: false, output: '도는 릴레이가 없어요' }
    const id = relay.jobs[relay.current]
    if (['running', 'blocked'].includes(relay.status) && id) await run(claudeBin, ['stop', id])
    relay.status = 'stopped'; relay.log.push('사람이 멈췄어요')
    return { ok: true, output: '릴레이를 멈췄어요' }
  },
  relayClear: () => { if (relay && !ACTIVE.includes(relay.status)) relay = null; return { ok: true, output: '' } },
  // 끼어들기 1: 아직 시작하지 않은 단계의 지시문을 고친다(늘리거나 줄이기 포함, 최대 4단계). 이미 시작한 단계는 못 고친다.
  relayEdit: ({ steps, review }) => {
    if (!relay || !ACTIVE.includes(relay.status)) return { ok: false, output: '도는 릴레이가 없어요' }
    const from = firstEditable(), list = Array.isArray(steps) ? steps.map((x) => String(x || '').trim()) : null
    if (!list) return null
    const next = [...relay.steps.slice(0, from), ...list.slice(from).filter(Boolean)].slice(0, RELAY_MAX_STEPS)
    relay.steps = next
    if (typeof review === 'boolean') relay.review = review
    relay.log.push('남은 단계를 고쳤어요')
    return { ok: true, output: `남은 단계를 고쳤어요 (${next.length}단계)` }
  },
  // 끼어들기 2: 지금 단계가 끝나면 다음 단계를 열기 전에 한 번 멈춘다.
  relayPause: () => {
    if (!relay || !['running', 'blocked'].includes(relay.status)) return { ok: false, output: '진행 중인 릴레이가 없어요' }
    relay.pauseNext = true
    return { ok: true, output: '이 단계가 끝나면 넘기기 전에 멈출게요' }
  },
  // 확인을 마치고 이어서 진행한다. 넘길 결과를 사람이 고쳤으면 그걸 넘긴다. 남은 단계가 없으면 그대로 끝낸다.
  relayResume: async ({ handoff }) => {
    if (!relay || relay.status !== 'review') return { ok: false, output: '확인을 기다리는 릴레이가 없어요' }
    if (typeof handoff === 'string') relay.results[relay.current - 1] = handoff.slice(0, 12000)
    if (relay.current >= relay.steps.length) { relay.status = 'done'; relay.log.push('릴레이 완료'); return { ok: true, output: '릴레이를 마쳤어요' } }
    relay.status = 'starting'; relay.log.push(`${relay.current}단계 결과를 확인하고 넘겼어요`)
    relayLaunch()
    return { ok: true, output: `${relay.current + 1}단계 세션이 뜨는 중이에요` }
  },
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

/* ---------- 팀: 다른 맥의 사무실 구경 ---------- */
// "공유 켜기"를 하면 별도 포트(기본 4778)로 이 맥의 세션을 읽기 전용으로 내보낸다. 같은 와이파이나 Tailscale 같은 사설망에서
// 초대 주소와 키를 아는 맥만 읽을 수 있다. 제어(멈춤, 새 세션, 릴레이)는 절대 내보내지 않는다.
// 다른 맥을 "동료"로 등록하면 이 서버가 대신 읽어 와서 화면에 방으로 보여준다. 설정은 ~/.dropdown-town/config.json 에 남는다.
const CONFIG_DIR = path.join(os.homedir(), '.dropdown-town'), CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
let config = { share: { enabled: false, key: null, name: os.hostname().split('.')[0], port: 4778 }, peers: [] }
async function loadConfig() {
  try {
    const j = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    config = { share: { ...config.share, ...(j.share || {}) }, peers: Array.isArray(j.peers) ? j.peers.filter((p) => p && typeof p.url === 'string' && typeof p.key === 'string') : [] }
  } catch {}
}
async function saveConfig() {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2))
}
const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address)
// 동료에게 내보내는 모양: 화면이 그대로 그릴 수 있는 세션 정보. 권한 대기 내용과 긴 요청문은 뺀다.
async function publicSnapshot() {
  const data = await collect()
  return {
    name: config.share.name, now: data.now,
    sessions: data.sessions.map((s) => ({ ...s, pending: null, intent: (s.intent || '').slice(0, 200) })),
    agents: data.agents.map((a) => ({ type: a.type, scope: a.scope, count: a.count, active: a.active, lastAt: a.lastAt, description: '', recent: [], byProject: a.byProject })),
    relay: data.relay && { name: data.relay.name, status: data.relay.status, step: data.relay.step, total: data.relay.total, jobs: data.relay.jobs, log: [] },
    avatars: liveAvatars(),
    chat: chatLog.slice(-30),
  }
}
// 아바타 위치 공유: 화면이 내 아바타 위치를 이 서버에 알리고(avatar 동작), 내가 동료 방에 있으면 그 동료의 공유 포트로 밀어 준다.
// 동료가 내 방에 오면 같은 방식으로 내 공유 포트에 들어오고(visitors), 내 화면과 다른 방문자에게 보인다. 12초 동안 소식이 없으면 사라진다.
const VISITOR_TTL = 12000
let myAvatar = null
const visitors = new Map(), pushedAt = new Map()
const cleanAvatar = (a) => ({ name: String(a.name || '').slice(0, 24), x: Number(a.x) || 0, y: Number(a.y) || 0, dir: ['up', 'down', 'left', 'right'].includes(a.dir) ? a.dir : 'down', look: a.look && typeof a.look === 'object' ? { body: Number(a.look.body) || 0, hairStyle: Number(a.look.hairStyle) || 0, outfit: Number(a.look.outfit) || 0, acc: String(a.look.acc || 'crown').slice(0, 12), accColor: String(a.look.accColor || '#ffffff').slice(0, 9), nick: String(a.look.nick || '').slice(0, 14), hair: String(a.look.hair || '#2b2230').slice(0, 9), skin: String(a.look.skin || '#f7d7b5').slice(0, 9), shirt: String(a.look.shirt || '#ff8a3d').slice(0, 9) } : {}, at: Date.now(),
  say: typeof a.say === 'string' ? a.say.replace(/\s+/g, ' ').trim().slice(0, 120) : '', sayAt: Number(a.sayAt) || 0, sayId: String(a.sayId || '').slice(0, 16) })
// 방 채팅: 방 주인과 방문자가 한 말을 이 방(내 서버)이 최근 50개까지 모아 두고, 방에 있는 모두에게 내보낸다.
const chatLog = [], seenSay = new Set()
function noteSay(a, owner) {
  if (!a.say || !a.sayId || seenSay.has(a.sayId)) return
  seenSay.add(a.sayId); if (seenSay.size > 500) seenSay.delete(seenSay.values().next().value)
  chatLog.push({ id: a.sayId, name: a.name, text: a.say, at: a.sayAt || Date.now(), owner })
  if (chatLog.length > 50) chatLog.shift()
}
function liveAvatars() { // 내 방에 있는 아바타들: 내 방에 있는 나 + 방문자들
  const out = []
  if (myAvatar && myAvatar.room === 'me' && Date.now() - myAvatar.at < VISITOR_TTL) out.push({ ...myAvatar, owner: true })
  for (const [name, a] of visitors) { if (Date.now() - a.at > VISITOR_TTL) visitors.delete(name); else out.push(a) }
  return out
}
async function pushAvatarTo(roomUrl) {
  const peer = config.peers.find((p) => p.url === roomUrl)
  if (!peer || !myAvatar) return
  pushedAt.set(roomUrl, Date.now())
  try { await fetch(`${peer.url}/peer/avatar`, { method: 'POST', headers: { 'x-town-key': peer.key, 'content-type': 'application/json' }, body: JSON.stringify(myAvatar), signal: AbortSignal.timeout(1500) }) } catch {}
}
let shareServer = null, shareError = null
function startShare() {
  if (shareServer || !config.share.enabled) return
  shareError = null
  shareServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (!config.share.key || req.headers['x-town-key'] !== config.share.key) { res.writeHead(403).end(); return }
    try {
      if (url.pathname === '/peer/avatar' && req.method === 'POST') { // 방문자 아바타 위치. 이름당 하나, 최대 12명
        const a = cleanAvatar(await readBody(req))
        if (a.name && (visitors.has(a.name) || visitors.size < 12)) { visitors.set(a.name, a); noteSay(a, false) }
        res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end('{"ok":true}'); return
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return }
      if (url.pathname === '/peer/hello') { res.writeHead(200, { 'content-type': TYPES['.json'] }); res.end(JSON.stringify({ name: config.share.name })); return }
      if (url.pathname === '/peer/sessions') { res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(await publicSnapshot())); return }
      res.writeHead(404).end()
    } catch { res.writeHead(500).end() }
  })
  shareServer.on('error', (err) => { shareError = err.code === 'EADDRINUSE' ? `포트 ${config.share.port} 를 다른 프로그램이 쓰고 있어요` : String(err.message || err); shareServer = null })
  shareServer.listen(config.share.port, '0.0.0.0')
}
function stopShare() { if (shareServer) { shareServer.close(); shareServer = null } }
let peerCache = { at: 0, value: [] }
async function fetchPeers() {
  if (Date.now() - peerCache.at < 2000) return peerCache.value
  const value = await Promise.all(config.peers.map(async (p) => {
    try {
      const r = await fetch(`${p.url.replace(/\/+$/, '')}/peer/sessions`, { headers: { 'x-town-key': p.key }, signal: AbortSignal.timeout(1500) })
      if (!r.ok) return { url: p.url, name: p.name, ok: false, error: r.status === 403 ? '키가 맞지 않아요' : `HTTP ${r.status}` }
      const j = await r.json()
      return { url: p.url, name: p.name || j.name, ok: true, sessions: j.sessions || [], agents: j.agents || [], relay: j.relay || null, avatars: Array.isArray(j.avatars) ? j.avatars.slice(0, 13).map((a) => ({ ...cleanAvatar(a), owner: Boolean(a.owner) })) : [], chat: Array.isArray(j.chat) ? j.chat.slice(-30).map((m) => ({ id: String(m.id || '').slice(0, 16), name: String(m.name || '').slice(0, 24), text: String(m.text || '').slice(0, 120), at: Number(m.at) || 0, owner: Boolean(m.owner) })) : [] }
    } catch (err) { return { url: p.url, name: p.name, ok: false, error: err.name === 'TimeoutError' ? '응답이 없어요 (맥이 잠들었거나 꺼져 있을 수 있어요)' : '연결하지 못했어요' } }
  }))
  peerCache = { at: Date.now(), value }
  return value
}
const teamInfo = () => ({ share: { enabled: config.share.enabled, name: config.share.name, port: config.share.port, key: config.share.enabled ? config.share.key : null, addresses: lanAddresses(), listening: Boolean(shareServer), error: shareError }, peers: config.peers.map((p) => ({ url: p.url, name: p.name })) })
const validPeerUrl = (u) => { try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x.origin : null } catch { return null } }
Object.assign(ACTIONS, {
  // 화면이 알려 주는 내 아바타. 동료 방에 있으면 그 동료에게 250ms 에 한 번까지 밀어 준다(움직이지 않을 때는 화면이 3초마다 보낸다).
  avatar: ({ room, ...a }) => {
    myAvatar = { ...cleanAvatar({ ...a, name: a.name || config.share.name }), room: typeof room === 'string' ? room : 'me' }
    if (myAvatar.room === 'me') noteSay(myAvatar, true)
    else if (myAvatar.say && !seenSay.has(myAvatar.sayId)) { seenSay.add(myAvatar.sayId); pushAvatarTo(myAvatar.room) } // 말은 기다리지 않고 바로 보낸다
    else if (Date.now() - (pushedAt.get(myAvatar.room) || 0) >= 250) pushAvatarTo(myAvatar.room)
    return { ok: true, output: '' }
  },
  shareOn: async ({ name }) => {
    config.share.enabled = true
    if (typeof name === 'string' && name.trim()) config.share.name = name.trim().slice(0, 24)
    if (!config.share.key) config.share.key = randomBytes(12).toString('hex')
    await saveConfig(); startShare()
    await new Promise((r) => setTimeout(r, 300))
    return shareServer ? { ok: true, output: `공유를 켰어요. 초대 주소: http://${lanAddresses()[0] || '이 맥의 IP'}:${config.share.port}` } : { ok: false, output: shareError || '공유 서버를 열지 못했어요' }
  },
  shareOff: async () => { config.share.enabled = false; stopShare(); await saveConfig(); return { ok: true, output: '공유를 껐어요' } },
  shareNewKey: async () => { config.share.key = randomBytes(12).toString('hex'); await saveConfig(); return { ok: true, output: '초대 키를 새로 만들었어요. 동료들은 새 키로 다시 등록해야 해요' } },
  peerAdd: async ({ url, key, name }) => {
    const origin = validPeerUrl(String(url || '').trim())
    if (!origin || typeof key !== 'string' || !key.trim()) return null
    if (config.peers.some((p) => p.url === origin)) return { ok: false, output: '이미 등록된 동료예요' }
    try {
      const r = await fetch(`${origin}/peer/hello`, { headers: { 'x-town-key': key.trim() }, signal: AbortSignal.timeout(3000) })
      if (r.status === 403) return { ok: false, output: '초대 키가 맞지 않아요' }
      if (!r.ok) return { ok: false, output: `연결은 됐지만 응답이 이상해요 (HTTP ${r.status})` }
      const j = await r.json()
      config.peers.push({ url: origin, key: key.trim(), name: String(name || j.name || '동료').slice(0, 24) })
      await saveConfig(); peerCache.at = 0
      return { ok: true, output: `‘${config.peers.at(-1).name}’ 의 사무실을 붙였어요` }
    } catch { return { ok: false, output: '그 주소에 연결하지 못했어요. 같은 와이파이인지, 상대가 공유를 켰는지 확인해 주세요' } }
  },
  peerRemove: async ({ url }) => { config.peers = config.peers.filter((p) => p.url !== url); await saveConfig(); peerCache.at = 0; return { ok: true, output: '동료를 뺐어요' } },
})
await loadConfig()
startShare()

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
      const [data, peers] = await Promise.all([collect(), fetchPeers()])
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ...data, team: { ...teamInfo(), peers, visitors: liveAvatars().filter((a) => !a.owner), chat: chatLog.slice(-30) } }))
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
