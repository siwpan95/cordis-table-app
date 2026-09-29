// _smoke_bridge.mjs —— JsonRpcBridge 的"worker 出问题时宿主不能陪葬"验收
//
// 用**假 worker**（一个会按需装死的 Python 脚本）验三件事：
//   1) worker 卡住时，调用在超时后 reject —— 而不是永久挂起；
//   2) 超时后 bridge 自动重启 worker（pid 变了、restarts 计数 +1）；
//   3) 重启后下一次调用能成功（"整个进程永久残废"被降级成"一次可重试的失败"）。
// 不依赖 openpyxl：假 worker 只做 JSON-RPC 回声，任何 Python 都能跑。
import { JsonRpcBridge } from './core/bridge.mjs'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

let failed = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log('  [ok] ' + msg)
  else { failed++; console.log('  [FAIL] ' + msg + (extra ? ' -> ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 找一个能用的 Python（这里不需要 openpyxl）
function anyPython() {
  for (const c of ['python', 'python3', 'py -3']) {
    try {
      execSync(c + ' -c "import sys"', { stdio: 'ignore', timeout: 5000 })
      return c
    } catch { /* 试下一个 */ }
  }
  return null
}

const py = anyPython()
if (!py) {
  console.log('  [info] 本机没有可用的 Python，跳过 bridge 超时验收（表格能力本来也不会启用）')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'table-bridge-'))
const marker = join(dir, 'hang.flag').replace(/\\/g, '/')
const script = join(dir, 'fake_worker.py')
// 假 worker：收到请求时若 marker 文件存在就**装死**（不响应）；否则正常回显。
// 用文件当开关，就能在同一个进程里造出"先卡住、重启后正常"的确定性场景。
// marker 路径直接写进脚本：桥用 spawn(argv 数组) 起进程，不经过 shell，
// 想靠"在 scriptPath 里塞引号带参数"是行不通的（会变成不存在的文件名）。
writeFileSync(script, [
  'import sys, os, json',
  'MARKER = ' + JSON.stringify(marker),
  'for line in sys.stdin:',
  '    line = line.strip()',
  '    if not line: continue',
  '    try: req = json.loads(line)',
  '    except Exception: continue',
  '    if req.get("method") == "exit": break',
  '    if os.path.exists(MARKER): continue',
  '    resp = {"jsonrpc": "2.0", "id": req.get("id"), "result": {"echo": req.get("method"), "pid": os.getpid()}}',
  '    sys.stdout.write(json.dumps(resp) + "\\n")',
  '    sys.stdout.flush()',
].join('\n'), 'utf8')

const bridge = new JsonRpcBridge(py, script, { timeoutMs: 800 })

let restarts = 0
bridge.onRestart = () => { restarts++ }
const pidOf = () => (bridge.child ? bridge.child.pid : null)

console.log('=== bridge 超时与自愈验收 ===')
const pid0 = await bridge.start()
const r1 = await bridge.call('ping', {})
ok(r1 && r1.echo === 'ping', '正常路径：调用成功', JSON.stringify(r1))

// 让 worker 装死，下一次调用必须"超时报错"而不是永久挂起
writeFileSync(marker, 'hang')
const t0 = Date.now()
let timedOut = null
try {
  await bridge.call('slow', {})
} catch (e) {
  timedOut = e
}
const cost = Date.now() - t0
ok(!!timedOut, 'worker 卡死时调用在超时后 reject（没有永久挂起）', String(timedOut && timedOut.message))
ok(/超时|重启/.test(timedOut ? timedOut.message : ''), '错误信息说明是超时且已重启', timedOut && timedOut.message)
ok(cost >= 700 && cost < 5000, '超时时间符合预期（~800ms 而不是立刻/无限）', cost + 'ms')
await sleep(300)
ok(restarts === 1, '触发了一次自动重启', 'restarts=' + restarts)
const pid1 = pidOf()
ok(pid1 && pid1 !== pid0, 'worker 进程确实换了一个（pid 变了）', pid0 + ' -> ' + pid1)

// 放开 marker：重启后的 worker 必须能正常干活
rmSync(marker, { force: true })
const r2 = await bridge.call('ping', {})
ok(r2 && r2.echo === 'ping', '重启后下一次调用自动成功（可重试，不用重启宿主）', JSON.stringify(r2))
ok(r2 && r2.pid === pid1, '新调用确实落在重启后的进程上', String(r2 && r2.pid))

// worker **崩溃**（不是卡住）的语义：桥把自身置为"未启动"，下一次调用直接拉起新进程。
// 这条很重要：如果退出后仍留着死进程引用，后续调用会写进死管道，既没响应也不触发重启，
// 只能干等到超时 —— 一次崩溃要让用户白等 15 秒。
const dying = bridge.child
dying.kill('SIGKILL')
await sleep(400)
ok(bridge.child === null, 'worker 崩溃后桥不留死管道引用（下一次调用会重新拉起）', String(bridge.child))
const r3 = await bridge.call('ping', {})
ok(r3 && r3.echo === 'ping', '崩溃后下一次调用自动拉起新 worker 并成功', JSON.stringify(r3))

// 冷启动宽限的 A/B 验收：同一个"首次响应慢 800ms"的 worker，
// 有宽限 -> 成功；把宽限关掉 -> 超时。证明宽限确实在保护冷启动，而不是碰巧。
const slowScript = join(dir, 'slow_first.py')
writeFileSync(slowScript, [
  'import sys, json, time',
  'first = True',
  'for line in sys.stdin:',
  '    line = line.strip()',
  '    if not line: continue',
  '    try: req = json.loads(line)',
  '    except Exception: continue',
  '    if req.get("method") == "exit": break',
  '    if first:',
  '        first = False',
  '        time.sleep(0.8)   # 模拟解释器启动 + 导入慢',
  '    resp = {"jsonrpc": "2.0", "id": req.get("id"), "result": {"echo": req.get("method")}}',
  '    sys.stdout.write(json.dumps(resp) + "\\n")',
  '    sys.stdout.flush()',
].join('\n'), 'utf8')

const withGrace = new JsonRpcBridge(py, slowScript, { timeoutMs: 300, coldStartGraceMs: 3000 })
await withGrace.start()
let graceOk = null
try { graceOk = await withGrace.call('ping', {}) } catch (e) { graceOk = e }
ok(graceOk && graceOk.echo === 'ping', '冷启动慢的 worker：有宽限 -> 第一笔调用成功', JSON.stringify(graceOk))
await withGrace.stop()

const noGrace = new JsonRpcBridge(py, slowScript, { timeoutMs: 300, coldStartGraceMs: 0 })
await noGrace.start()
let graceFail = null
try { graceFail = await noGrace.call('ping', {}) } catch (e) { graceFail = e }
ok(graceFail instanceof Error && /超时/.test(graceFail.message),
  '同一 worker、同一超时：关掉宽限 -> 如实超时（证明宽限才是成功的原因）',
  String(graceFail && graceFail.message))
await noGrace.stop()

await bridge.stop()
rmSync(dir, { recursive: true, force: true })
console.log('\n=== 结果 ===')
console.log(failed === 0 ? '  ALL PASS' : '  FAILED: ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
