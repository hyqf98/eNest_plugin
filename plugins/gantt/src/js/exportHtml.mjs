/**
 * exportHtml.mjs —— 自包含 HTML 导出（markdown ExportMenu 先例：内联 CSS 静态渲染）
 * CSS Grid 行条 + SVG 依赖线 + 今天线 + 图例 + 统计头；无 JS、无外部资源。
 */
import { flattenTasks, summarize, diffDays, planStats, todayStr, fmtDate } from './model.mjs'
import { dayIndex } from './timeScale.mjs'

const LIGHT_PALETTE = [
  '#0d9488', '#6366f1', '#e8930c', '#d946a0', '#0e9f6e',
  '#e11d48', '#2570eb', '#8b5cf6', '#0aa2c0', '#b45309'
]

function esc(s) {
  return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function exportPlanHtml(plan) {
  const summaries = summarize(plan.tasks)
  const flat = flattenTasks(plan.tasks, { respectCollapsed: false })
  const stats = planStats(plan)
  const today = todayStr()

  let min = Infinity
  let max = -Infinity
  for (const row of flat) {
    const s = summaries.get(row.task.id)
    if (!s) continue
    min = Math.min(min, dayIndex(s.start))
    max = Math.max(max, dayIndex(s.end))
  }
  const ti = dayIndex(today)
  min = Math.min(min, ti) - 3
  max = Math.max(max, ti) + 3
  const totalDays = max - min + 1
  const DAY_W = 34
  const LEFT_W = 230
  const ROW_H = 40
  const HEAD_H = 44
  const W = LEFT_W + totalDays * DAY_W

  const byIdx = new Map(flat.map((r, i) => [r.task.id, i]))

  /* 顶部日期刻度（按周分格，标注周一） */
  const ticks = []
  for (let i = min; i <= max; i++) {
    const d = new Date(2020, 0, 6 + i)
    if (d.getDay() === 1 || i === min) {
      ticks.push({ x: (i - min) * DAY_W, label: `${d.getMonth() + 1}/${d.getDate()}` })
    }
  }

  const rowsHtml = flat.map((row, i) => {
    const t = row.task
    const s = summaries.get(t.id) || { start: t.start, end: t.end, progress: t.progress }
    const left = (dayIndex(s.start) - min) * DAY_W
    const width = Math.max((diffDays(s.end, s.start) + 1) * DAY_W, DAY_W)
    const color = LIGHT_PALETTE[t.colorIndex % 10]
    const y = i * ROW_H + (ROW_H - 20) / 2
    const bar = t.milestone
      ? `<div class="ms" style="left:${left + DAY_W / 2 - 8}px;background:${color};box-shadow:0 4px 12px ${color}55" title="${esc(t.name)} ${esc(s.start)}"></div>`
      : row.isParent
        ? `<div class="bar parent" style="left:${left}px;width:${width}px;border-color:${color}"></div>`
        : `<div class="bar" style="left:${left}px;width:${width}px;background:${color}26;border-color:${color}66;box-shadow:0 4px 12px ${color}35"><i style="width:${s.progress}%;background:${color}"></i><span>${esc(t.name)}</span></div>`
    return `<div class="row">
<div class="label" style="padding-left:${14 + row.depth * 14}px">${row.isParent ? '<b>' : ''}${esc(t.name)}${row.isParent ? '</b>' : ''}<em>${s.progress}%</em></div>
<div class="lane" style="width:${totalDays * DAY_W}px">${bar}</div>
</div>`
  }).join('')

  const links = []
  for (const row of flat) {
    const t = row.task
    const myIdx = byIdx.get(t.id)
    for (const depId of t.deps || []) {
      const depIdx = byIdx.get(depId)
      if (depIdx === undefined) continue
      const ds = summaries.get(depId)
      const ms = summaries.get(t.id)
      if (!ds || !ms) continue
      const x1 = (dayIndex(ds.end) - min + 1) * DAY_W
      const y1 = depIdx * ROW_H + ROW_H / 2
      const x2 = (dayIndex(ms.start) - min) * DAY_W
      const y2 = myIdx * ROW_H + ROW_H / 2
      const forward = x2 >= x1
      const midX = forward ? x1 + Math.max(14, (x2 - x1) / 2) : x1 + 16
      links.push(`<path d="M ${x1} ${y1} C ${midX} ${y1}, ${forward ? midX : x2 - 16} ${y2}, ${x2} ${y2}"/>`)
    }
  }

  const todayLeft = (ti - min) * DAY_W + DAY_W / 2
  const rangeText = flat.length ? `${fmtDate(stats.range.start)} - ${fmtDate(stats.range.end)}` : '-'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>甘特图 · ${esc(plan.name)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; margin: 0; }
body { font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f4f5f7; color: #1c1e21; padding: 28px; }
.wrap { max-width: 100%; overflow-x: auto; border-radius: 16px; background: #fff; border: 1px solid rgba(0,0,0,.08); box-shadow: 0 12px 40px rgba(0,0,0,.08); padding: 20px 22px; }
h1 { font-size: 17px; margin-bottom: 2px; }
.meta { font-size: 12px; color: #7a7f87; margin-bottom: 16px; }
.meta b { color: #0d9488; font-weight: 600; }
.sheet { position: relative; width: ${W}px; }
.head { display: flex; height: ${HEAD_H}px; border-bottom: 1px solid rgba(0,0,0,.1); margin-bottom: 4px; }
.head .label { width: ${LEFT_W}px; flex: none; color: #9aa0a8; font-size: 12px; }
.ticks { position: relative; flex: 1; }
.ticks span { position: absolute; top: 12px; font-size: 11px; color: #9aa0a8; white-space: nowrap; }
.row { display: flex; height: ${ROW_H}px; border-radius: 8px; }
.row:nth-child(even) { background: rgba(0,0,0,.018); }
.label { width: ${LEFT_W}px; flex: none; display: flex; align-items: center; gap: 6px; font-size: 12.5px; padding-right: 8px; white-space: nowrap; overflow: hidden; }
.label em { font-style: normal; color: #9aa0a8; font-size: 11px; margin-left: auto; flex: none; }
.lane { position: relative; }
.bar { position: absolute; top: ${(ROW_H - 20) / 2}px; height: 20px; border-radius: 999px; border: 1px solid; overflow: hidden; display: flex; align-items: center; }
.bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; }
.bar span { position: relative; padding: 0 9px; font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar.parent { height: 11px; top: ${(ROW_H - 11) / 2 - 4}px; border-width: 1.5px; background: transparent; }
.bar.parent::after { content: ""; position: absolute; right: -3px; bottom: -4px; width: 5px; height: 5px; transform: translateX(-1px) rotate(45deg); border-right: 1.5px solid; border-bottom: 1.5px solid; border-color: inherit; }
.ms { position: absolute; top: ${(ROW_H - 15) / 2}px; width: 15px; height: 15px; transform: rotate(45deg); border-radius: 4px; border: 1.5px solid rgba(0,0,0,.15); }
.links { position: absolute; left: ${LEFT_W}px; top: ${HEAD_H + 4}px; pointer-events: none; }
.links path { fill: none; stroke: #8b9199; stroke-width: 1.6; opacity: .75; }
.today { position: absolute; left: ${LEFT_W + todayLeft}px; top: 0; bottom: 0; border-left: 1.5px dashed #0d9488aa; z-index: 3; }
.legend { display: flex; gap: 14px; margin-top: 14px; font-size: 11.5px; color: #7a7f87; flex-wrap: wrap; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 999px; margin-right: 5px; vertical-align: -1px; }
</style>
</head>
<body>
<div class="wrap">
<h1>${esc(plan.name)}</h1>
<div class="meta">${stats.leaves} 项任务 · 平均进度 <b>${stats.progress}%</b> · ${stats.status.done} 已完成 · ${stats.status.ongoing} 进行中 · ${stats.status.todo} 待开始${stats.status.overdue ? ` · <span style="color:#e11d48">${stats.status.overdue} 逾期</span>` : ''} · ${rangeText} · 导出于 ${esc(today)}</div>
<div class="sheet">
<div class="head"><div class="label">任务</div><div class="ticks">${ticks.map(t => `<span style="left:${t.x}px">${esc(t.label)}</span>`).join('')}</div></div>
${rowsHtml}
<div class="today"></div>
<svg class="links" width="${totalDays * DAY_W}" height="${flat.length * ROW_H}">${links.join('')}</svg>
</div>
<div class="legend">
<span><i style="background:#0d9488"></i>任务条颜色 = 计划内分类色</span>
<span>◆ 里程碑</span>
<span>细边框条 = 父任务汇总</span>
<span>虚线 = 今天（${esc(today)}）</span>
<span>连线 = 完成-开始依赖</span>
</div>
</div>
</body>
</html>`
}
