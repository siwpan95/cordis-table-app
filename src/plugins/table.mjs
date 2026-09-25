// TableService —— Cordis 服务，挂到 ctx.table
// 它是"构造器插件"：被 Cordis 实例化后通过 Service 基类提供 ctx.table；
// 内部 spawn 一个 Python OpenPyXL worker（JsonRpcBridge），所有表格操作经 JSON-RPC 转发。
import { Service } from 'cordis'
import { JsonRpcBridge } from '../core/bridge.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(__dirname, '../../python/rpc_server.py')

// 自发现 Python 解释器（全程不硬编码任何本机盘符）：
//   1) cordis.json 里 table 条目的 config.pythonBin（显式优先）
//   2) 环境变量 PYTHON_BIN
//   3) `py` 官方启动器 / PATH 里的 python（最常见、也最符合系统约定）
//   4) **遍历所有就绪盘符**探测常见安装落点（Python3XX 根目录 + 用户级安装目录）
// 换机 / 换系统 / 装到任意盘都能直接用，无需改代码。
//
// 2026-09-25 修正：原实现把候选表写死成 C:/D: 上的几个标准落点，注释却声称
// "不硬编码任何本机盘符"——**声称与实现对不上**：装到 F: 盘或用户级目录就一个都不命中，
// 表现为"明明装了 Python 却找不到"。死根路径门禁报出 6 处即此因。
// 现改为按盘符枚举 + 用户级目录探测，不再出现任何写死的绝对路径。
const POSIX_COMMON = [
  '/usr/bin/python3',
  '/usr/local/bin/python3',
  '/opt/homebrew/bin/python3',
  '/usr/bin/python',
]
const PY_VERSIONS_MAC = ['314', '313', '312', '311']

function pathCandidates() {
  const out = []
  const pathEnv = process.env.PATH || ''
  const sepCh = process.platform === 'win32' ? ';' : ':'
  const names = process.platform === 'win32'
    ? ['python.exe', 'python3.exe', 'pythonw.exe']
    : ['python3', 'python']
  for (const dir of pathEnv.split(sepCh)) {
    if (!dir) continue
    for (const n of names) {
      const p = resolve(dir, n)
      try { if (existsSync(p)) out.push(p) } catch { /* ignore */ }
    }
  }
  return out
}

// 枚举 Windows 上"当前就绪"的盘符，用于在各盘根目录探测 Python 安装。
// 不写死任何盘符：只探测**实际存在**的盘，装机盘符变了也能命中。
function driveLetters() {
  if (process.platform !== 'win32') return []
  const out = []
  for (let c = 65; c <= 90; c++) {          // A..Z
    const d = String.fromCharCode(c)
    try {
      // 探测根目录是否可访问（不存在的盘会抛错）
      if (existsSync(d + ':/')) out.push(d)
    } catch { /* ignore */ }
  }
  return out
}

// 项目级落点：放在系统级之前。理由：项目自带解释器（.venv）最能保证依赖齐备；
// 而系统 PATH 里可能有一个装了 openpyxl 但版本/环境有问题的解释器（本机实测踩中）。
function projectCandidates() {
  if (process.platform !== 'win32') return []
  return [
    resolve(__dirname, '../../.venv/Scripts/python.exe'),
    resolve(__dirname, '../../venv/Scripts/python.exe'),
  ]
}

function commonCandidates() {
  if (process.platform !== 'win32') {
    const extra = []
    for (const v of PY_VERSIONS_MAC) {
      extra.push('/Library/Frameworks/Python.framework/Versions/3.' + v.slice(1) + '/bin/python3')
    }
    return [...POSIX_COMMON, ...extra]
  }
  const out = []
  const localApp = process.env.LOCALAPPDATA || ''
  const progFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
  // ⓪ 项目级虚拟环境已由 projectCandidates() 单独前插，此处不再重复
  // ① 用户级安装（官方安装器默认落点，与盘符无关）
  const localRoot = localApp ? resolve(localApp, 'Programs/Python') : ''
  // ② 系统级安装落点
  const roots = [localRoot, ...progFiles.map((p) => resolve(p, 'Python'))].filter(Boolean)
  for (const root of roots) {
    for (const v of ['314', '313', '312', '311', '310']) {
      out.push(resolve(root, 'Python' + v, 'python.exe'))
    }
    out.push(resolve(root, 'python.exe'))
  }
  // ③ 遍历所有就绪盘符的根目录（覆盖装在非系统盘的情况，如 F:\Python314）
  for (const drive of driveLetters()) {
    for (const v of ['314', '313', '312', '311', '310']) {
      out.push(drive + ':/Python' + v + '/python.exe')
    }
    out.push(drive + ':/Python/python.exe')
  }
  return out
}

function canImportOpenpyxl(bin) {
  try {
    execSync('"' + bin + '" -c "import openpyxl"', { stdio: 'ignore', timeout: 8000 })
    return true
  } catch {
    return false
  }
}

export function resolvePythonBin(config) {
  if (config && config.pythonBin) return config.pythonBin
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN

  // 优先级（2026-09-25 实测调整）：
  //   ① 项目级 .venv —— 项目自带解释器，依赖最可控
  //   ② `py -3` —— Windows 官方启动器（本机实测指向 3.13.14，无 CPython 相对导入崩溃 bug）
  //   ③ PATH 里的 python —— 系统默认
  //   ④ 系统级/盘符枚举的常见安装落点
  // 原实现把 PATH 排在项目级之前，实测选到了 PATH 里那个有 bug 的 3.14.7。
  const candidates = [
    ...projectCandidates(),
    'py -3',
    ...pathCandidates(),
    ...commonCandidates(),
    'python3',
    'python',
  ]
  const seen = new Set()
  let firstExisting = null
  for (const c of candidates) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    // 带参数的启动器（py -3）与裸命令名由操作系统解析，直接探活
    if (c.includes(sep) && !existsSync(c)) continue
    if (canImportOpenpyxl(c)) return c
    if (!firstExisting) firstExisting = c
  }
  // 没有任何一个带 openpyxl：回退到首个探活对象（让它去报缺依赖，错误信息更明确）
  return firstExisting || 'python3'
}

export class TableService extends Service {
  static provide = 'table'

  constructor(ctx, config) {
    super(ctx, 'table')
    this.config = config || {}
    const pythonBin = resolvePythonBin(this.config)
    this.bridge = new JsonRpcBridge(pythonBin, SCRIPT)
    this.pid = null
  }

  // Service.init：返回清理函数（fiber dispose 时执行 -> 杀掉 python worker）
  [Service.init]() {
    const bridge = this.bridge
    const ready = bridge.start()
    ready.then((pid) => {
      this.pid = pid
    })
    bridge.onExit = (code) => {
      this.ctx?.logger?.debug?.('python worker exited (code ' + code + ')')
    }
    return () => {
      bridge.stop()
    }
  }

  // ---- RPC 代理方法（与 python/rpc_server.py 的 method 一一对应）----
  ping() {
    return this.bridge.call('ping', {})
  }
  createWorkbook(path, sheet) {
    return this.bridge.call('create_workbook', { path, sheet })
  }
  addSheet(path, name) {
    return this.bridge.call('add_sheet', { path, name })
  }
  writeRows(path, sheet, startRow, startCol, rows) {
    return this.bridge.call('write_rows', { path, sheet, start_row: startRow, start_col: startCol, rows })
  }
  writeCell(path, sheet, row, col, value) {
    return this.bridge.call('write_cell', { path, sheet, row, col, value })
  }
  styleHeader(path, sheet, row, ncols, opts = {}) {
    return this.bridge.call('style_header', { path, sheet, row, ncols, ...opts })
  }
  setColumnWidth(path, sheet, col, width) {
    return this.bridge.call('set_column_width', { path, sheet, col, width })
  }
  readSheet(path, sheet) {
    return this.bridge.call('read_sheet', { path, sheet })
  }
  save(path) {
    return this.bridge.call('save', { path })
  }
  close(path) {
    return this.bridge.call('close', { path })
  }

  // ---- 地图相关方法（与 python/rpc_server.py 的 method 对应，共用同一 worker）----
  setCellFill(path, sheet, row, col, color) {
    return this.bridge.call('set_cell_fill', { path, sheet, row, col, color })
  }
  mergeCells(path, sheet, r1, c1, r2, c2) {
    return this.bridge.call('merge_cells', { path, sheet, r1, c1, r2, c2 })
  }
  setCellText(path, sheet, row, col, text) {
    return this.bridge.call('set_cell_text', { path, sheet, row, col, text })
  }
  setComment(path, sheet, row, col, text) {
    return this.bridge.call('set_comment', { path, sheet, row, col, text })
  }
  setBorders(path, sheet, r1, c1, r2, c2, opts = {}) {
    return this.bridge.call('set_borders', { path, sheet, r1, c1, r2, c2, ...opts })
  }
  readMap(path, sheet) {
    return this.bridge.call('read_map', { path, sheet })
  }
  renderMapPng(path, sheet, out, px = 100, grid = false) {
    return this.bridge.call('render_map_png', { path, sheet, out, px, grid })
  }
  renderToken(text, out, size = 400, color = 'FF4F81BD') {
    return this.bridge.call('render_token', { text, out, size, color })
  }
  genDungeon(path, opts = {}) {
    return this.bridge.call('gen_dungeon', { path, ...opts })
  }
  // ---- DonJon 风格 JSON 互通 ----
  // 导出：把 Map 表 + 数据表 -> DonJon 风格 JSON 文件（out）
  exportDonjon(path, out, opts = {}) {
    return this.bridge.call('export_donjon', { path, out, ...opts })
  }
  // 导入：把 DonJon 风格 JSON 文件（json）-> 新 Map 表 + 数据表
  importDonjon(path, jsonPath, opts = {}) {
    return this.bridge.call('import_donjon', { path, json: jsonPath, ...opts })
  }
}

export default TableService
