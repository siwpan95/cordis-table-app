// _smoke_chart.mjs —— 图表能力的验收
//
// 为什么单独测：图表是"写进 xlsx 的 XML 对象"，光看单元格数据完全看不出来。
// 所以这里做两层验证：
//   1) sheet_meta 报出的 charts 类名（内存对象）；
//   2) **另起一个进程**用 openpyxl 打开落盘文件数图表 —— 证明它真的写进了文件，
//      而不是只挂在内存对象上（关掉进程就没了）。
import { bootHost, stopHost } from './boot.mjs'
import { resolvePythonBin } from './plugins/table.mjs'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

let failed = 0
const ok = (cond, msg, extra = '') => {
  if (cond) console.log('  [ok] ' + msg)
  else { failed++; console.log('  [FAIL] ' + msg + (extra ? ' -> ' + extra : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'table-chart-'))
const file = join(dir, 'chart.xlsx').replace(/\\/g, '/')
const cfg = join(dir, 'cordis.json')
writeFileSync(cfg, JSON.stringify({ entries: [{ id: 'table', name: './src/plugins/table.mjs' }] }, null, 2))

console.log('=== 图表验收 ===')
const ctx = await bootHost({ config: cfg })
const t = ctx.table
if (!t) {
  console.log('  [info] 本机没启用表格能力（没探测到 Python + openpyxl），跳过')
  await stopHost()
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

// 造一份"每日"数据：表头 + 5 天
await t.createWorkbook(file, '每日')
await t.writeRows(file, '每日', 1, 1, [
  ['日期', '完成番茄', '作废', '专注(分钟)'],
  ['2026-09-01', 3, 0, 75],
  ['2026-09-02', 5, 1, 125],
  ['2026-09-03', 2, 0, 50],
  ['2026-09-04', 6, 0, 150],
  ['2026-09-05', 4, 0, 100],
], { colTypes: ['date', 'number', 'number', 'number'] })

const bar = await t.addChart(file, '每日', {
  type: 'col', title: '每日完成番茄', anchor: 'F2', height: 7, width: 14,
  x_title: '日期', y_title: '番茄数',
  cats: { col: 1, min_row: 2, max_row: 6 },
  series: [{ col: 2, min_row: 1, max_row: 6, title_from_data: true }],
})
ok(bar && bar.charts === 1, '柱状图加上了（1 个）', JSON.stringify(bar))

const line = await t.addChart(file, '每日', {
  type: 'line', title: '每日专注时长', anchor: 'F18', height: 7, width: 14,
  cats: { col: 1, min_row: 2, max_row: 6 },
  series: [{ col: 4, min_row: 1, max_row: 6, title_from_data: true }],
})
ok(line && line.charts === 2, '折线图也加上了（累计 2 个）', JSON.stringify(line))

// 字面标题（没有表头单元格）与饼图
const pie = await t.addChart(file, '每日', {
  type: 'pie', title: '完成占比', anchor: 'F34', height: 7, width: 12,
  cats: { col: 1, min_row: 2, max_row: 6 },
  series: [{ col: 2, min_row: 2, max_row: 6, title: '完成番茄' }],
})
ok(pie && pie.charts === 3, '饼图 + 字面系列标题也支持', JSON.stringify(pie))

// 非法类型要给人话
let badType = null
try {
  await t.addChart(file, '每日', { type: 'donut', cat: {}, series: [] })
} catch (e) {
  badType = e
}
ok(badType && /不支持的图表类型/.test(badType.message), '未知图表类型 -> 可读错误', String(badType && badType.message))

const meta = await t.sheetMeta(file, '每日')
ok(meta.charts.length === 3 && meta.charts.includes('BarChart') && meta.charts.includes('LineChart') && meta.charts.includes('PieChart'),
  'sheet_meta 报出三种图表类名', JSON.stringify(meta.charts))

await t.save(file)
ok(existsSync(file), '文件已落盘', file)
await stopHost()

// 关键的第二层：另起进程读磁盘上的文件
const py = resolvePythonBin({})
const probe = [
  'import sys, openpyxl',
  'wb = openpyxl.load_workbook(sys.argv[1])',
  'ws = wb["每日"]',
  'print("charts=%d types=%s" % (len(ws._charts), ",".join(type(c).__name__ for c in ws._charts)))',
  'print("series=%d" % sum(len(c.series) for c in ws._charts))',
  'c0 = ws._charts[0]',
  'print("val=%s" % c0.series[0].val.numRef.f)',
  // 分类轴：必须在加完系列之后设置才挂得上（先设后加会静默丢失）—— 这条专门盯它
  'print("cat=%s" % (c0.series[0].cat.numRef.f if c0.series[0].cat is not None else "MISSING"))',
  'print("anchor=%s,%s" % (c0.anchor._from.col, c0.anchor._from.row))',
].join('\n')
const r = spawnSync(py, ['-c', probe, file], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
const out = (r.stdout || '').trim()
console.log('  [info] 另一个进程读回：' + out.split('\n').join(' | '))
ok(/charts=3/.test(out), '落盘文件里确实有 3 个图表（不是只在内存里）', out)
ok(/BarChart/.test(out) && /LineChart/.test(out) && /PieChart/.test(out), '图表类型在文件里也对', out)
ok(/series=3/.test(out), '系列数正确（每个图 1 个系列）', out)
ok(/val=.*\$B\$2:\$B\$6/.test(out), '柱图数据引用指向 B2:B6', out)
ok(/cat=.*\$A\$2:\$A\$6/.test(out) && !/cat=MISSING/.test(out),
  '分类轴已挂上并指向 A2:A6（先设后加系列会静默丢失）', out)
ok(/anchor=5,1/.test(out), '锚点落在 F2（列 5、行 1，0 基）', out)

rmSync(dir, { recursive: true, force: true })
console.log('\n=== 结果 ===')
console.log(failed === 0 ? '  ALL PASS' : '  FAILED: ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
