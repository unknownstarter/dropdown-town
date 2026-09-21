#!/usr/bin/env node
// README 용 GIF 의 프레임을 뽑는다. 설치할 패키지 없이 크롬의 원격 디버깅(CDP)만 쓴다.
// 쓰는 법: node server.mjs 를 켜 둔 채로
//   node scripts/capture-frames.mjs <프레임을 둘 폴더> [초=22] [초당 프레임=10]
// 화면의 ?capture 모드는 시간이 저절로 흐르지 않고 __tick(ms) 을 부를 때만 흐르므로, 찍는 속도와 상관없이 움직임이 일정하다.
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const [outDir, seconds = '22', fps = '10'] = process.argv.slice(2)
if (!outDir) { console.error('프레임을 둘 폴더를 알려주세요'); process.exit(1) }
const PORT = 9377, URL_ = `http://localhost:${process.env.TOWN_PORT || 4777}/?demo=story&capture=1`
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = path.join(os.tmpdir(), `town-capture-${process.pid}`)

await mkdir(outDir, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1100,760', URL_], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250)
  target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null)
}
if (!target) { chrome.kill(); throw new Error('크롬에 연결하지 못했어요') }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail })
let seq = 0
const waiting = new Map()
ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id) } }
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  waiting.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)))
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value

try {
  for (let i = 0; i < 60 && !(await evaluate('typeof __ready === "function" && __ready()')); i++) await sleep(250)
  await evaluate('__tick(0)')
  const clip = await evaluate('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()')
  const frames = Number(seconds) * Number(fps), step = 1000 / Number(fps)
  for (let i = 0; i < frames; i++) {
    await evaluate(`__tick(${step})`)
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })
    await writeFile(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'))
  }
  console.log(`${frames}장 저장: ${outDir} (${clip.width}x${clip.height})`)
} finally {
  ws.close(); chrome.kill()
  await sleep(300); await rm(profile, { recursive: true, force: true }).catch(() => {})
}
