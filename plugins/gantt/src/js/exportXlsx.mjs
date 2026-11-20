/**
 * exportXlsx.mjs —— 最小 .xlsx 导出（无第三方表格库）
 * fflate zipSync 打包手写 OOXML：[Content_Types].xml / _rels/.rels /
 * xl/workbook.xml / xl/_rels/workbook.xml.rels / xl/worksheets/sheet1.xml /
 * xl/styles.xml。任务色填充走 styles.xml 动态生成 fill；日期以文本单元格
 * 写入（避免时区/序列号坑），数值列为 number。输出 dataURL 供 kit.saveFile。
 */
import { zipSync, strToU8 } from 'fflate'
import { flattenTasks, summarize, diffDays, planStats, todayStr } from './model.mjs'

/* 色板（与 CSS --gt-c0..9 浅色模式一致） */
const LIGHT_PALETTE = [
  '#0d9488', '#6366f1', '#e8930c', '#d946a0', '#0e9f6e',
  '#e11d48', '#2570eb', '#8b5cf6', '#0aa2c0', '#b45309'
]

function xmlEscape(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** '0d9488' -> 'FF0D9488' */
function argb(hex) {
  return ('FF' + hex.replace('#', '').toUpperCase())
}

function colLetter(i) {
  let s = ''
  let n = i + 1
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/**
 * styles.xml：0 默认 / 1 表头 / 2..11 色板 fill / 12 里程碑粗体
 * 索引映射：fill cell xf = 2 + colorIndex
 */
function buildStyles() {
  const fills = LIGHT_PALETTE.map(c =>
    `<fill><patternFill patternType="solid"><fgColor rgb="${argb(c)}"/><bgColor indexed="64"/></patternFill></fill>`)
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>',
    ...LIGHT_PALETTE.map((_, i) =>
      `<xf numFmtId="0" fontId="2" fillId="${i + 2}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>`),
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>'
  ]
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFB45309"/><name val="Calibri"/></font>
</fonts>
<fills count="${LIGHT_PALETTE.length + 2}">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
${fills.join('')}
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD9D9D9"/></left><right style="thin"><color rgb="FFD9D9D9"/></right><top style="thin"><color rgb="FFD9D9D9"/></top><bottom style="thin"><color rgb="FFD9D9D9"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
}

function buildSheet(plan) {
  const summaries = summarize(plan.tasks)
  const flat = flattenTasks(plan.tasks, { respectCollapsed: false })
  const byId = new Map(plan.tasks.map(t => [t.id, t]))
  const rowsXml = []

  // 表头
  const headers = ['任务', '开始', '结束', '时长(天)', '进度', '里程碑', '前置任务', '备注']
  rowsXml.push(`<row r="1">${headers.map((h, i) =>
    `<c r="${colLetter(i)}1" t="inlineStr" s="1"><is><t>${xmlEscape(h)}</t></is></c>`).join('')}</row>`)

  flat.forEach((row, idx) => {
    const t = row.task
    const sum = summaries.get(t.id) || { start: t.start, end: t.end, progress: t.progress }
    const r = idx + 2
    const indent = '    '.repeat(row.depth)
    const depNames = (t.deps || []).map(d => byId.get(d)?.name).filter(Boolean).join('、')
    const cells = [
      { v: `${indent}${t.name}`, t: 'inlineStr', s: 2 + (t.colorIndex % 10) },
      { v: sum.start, t: 'inlineStr' },
      { v: sum.end, t: 'inlineStr' },
      { v: t.milestone ? 0 : diffDays(sum.end, sum.start) + 1, t: 'n' },
      { v: `${sum.progress}%`, t: 'inlineStr' },
      { v: t.milestone ? '◆' : '', t: 'inlineStr' },
      { v: depNames, t: 'inlineStr' },
      { v: t.note || '', t: 'inlineStr' }
    ]
    rowsXml.push(`<row r="${r}">${cells.map((c, i) => {
      if (c.t === 'n') return `<c r="${colLetter(i)}${r}" s="${c.s ?? 0}"><v>${c.v}</v></c>`
      const style = c.s ? ` s="${c.s}"` : ''
      return c.v === '' ? '' : `<c r="${colLetter(i)}${r}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(c.v)}</t></is></c>`
    }).join('')}</row>`)
  })

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<cols>
<col min="1" max="1" width="34" customWidth="1"/>
<col min="2" max="3" width="12" customWidth="1"/>
<col min="4" max="5" width="9" customWidth="1"/>
<col min="6" max="6" width="8" customWidth="1"/>
<col min="7" max="7" width="26" customWidth="1"/>
<col min="8" max="8" width="30" customWidth="1"/>
</cols>
<sheetData>${rowsXml.join('')}</sheetData>
</worksheet>`
}

export function exportPlanXlsx(plan) {
  const sheetName = '甘特图'
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/worksheets/sheet1.xml': strToU8(buildSheet(plan)),
    'xl/styles.xml': strToU8(buildStyles())
  }
  const zipped = zipSync(files, { level: 6 })
  // Uint8Array -> base64 -> dataURL（分块避免栈溢出）
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < zipped.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, zipped.subarray(i, i + CHUNK))
  }
  const base64 = btoa(binary)
  return Promise.resolve(`data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`)
}

/** 供计划右键/导出菜单取统计行（可选用于 sheet 尾部摘要，暂不写） */
export function xlsxMeta(plan) {
  return { stats: planStats(plan), date: todayStr() }
}
