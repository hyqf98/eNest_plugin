/**
 * catalog.mjs — 数据库 AI 助手的 A2UI 自定义组件目录（v1.0）
 * catalogId: https://enest.local/catalogs/db-ai/v1（agent 与渲染侧同源代码，直接代码注册）
 * 组件：
 *   EChart   — option 纯 JSON 对象（A2UI 数据面天然无函数），复用 a2ui/charts.mjs 引擎
 *   Mermaid  — code 字符串，复用 mermaid 懒加载 + 降级卡
 *   DbTable  — 工具结果的交互表格（columns/rows 可 @path 绑定 /toolResults/<i>）
 *   SqlConfirm — 写操作确认卡；由 app 侧生成，模型侧目录经 ComponentPruningTransformer
 *              剪掉该组件（模型永远不能自绘确认界面——安全门留在应用侧）
 * 空态引导（欢迎页）走 basicCatalog 组件 + dataModel，不需要专用组件。
 */

import { z } from 'zod'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createComponentImplementation } from '@a2ui/react'
import { Catalog, DynamicStringSchema, DynamicValueSchema } from '@a2ui/web_core/v1_0'
import { renderMermaid, renderEChartOption, disposeChart, resizeChart, isDarkTheme } from './charts.mjs'

export const DB_AI_CATALOG_ID = 'https://enest.local/catalogs/db-ai/v1'
/** 模型侧目录不暴露的组件（app 专用） */
export const APP_ONLY_COMPONENTS = ['SqlConfirm']

/* ── EChart ── */

const EChartImpl = createComponentImplementation(
  {
    name: 'EChart',
    description: 'ECharts chart. The option must be a plain JSON ECharts option (no functions). Supports bar/line/pie/scatter. You may bind option via {"@path": "/toolResults/<n>/..."} to reuse chart data from tool results.',
    schema: z.object({
      option: DynamicValueSchema.describe('ECharts option object, plain JSON only'),
      height: z.number().int().min(120).max(640).optional().describe('Chart height in px, default 260')
    })
  },
  ({ props }) => {
    const ref = useRef(null)
    const height = props.height || 260
    const themeKey = useThemeKey()
    useEffect(() => {
      const container = ref.current
      if (!container) return
      void renderEChartOption(props.option, container)
      return () => disposeChart(container)
    }, [props.option, themeKey])
    useEffect(() => {
      // resize 去抖 + 尺寸未变跳过：echarts.init 会写容器 style，裸 ResizeObserver
      // 会在零尺寸容器上形成 resize 循环风暴
      let timer = null
      let lastW = 0
      let lastH = 0
      const observer = new ResizeObserver(() => {
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          const el = ref.current
          if (!el) return
          const rect = el.getBoundingClientRect()
          if (rect.width === lastW && rect.height === lastH) return
          lastW = rect.width
          lastH = rect.height
          if (rect.width > 0 && rect.height > 0) resizeChart(el)
        }, 120)
      })
      if (ref.current) observer.observe(ref.current)
      return () => { if (timer) clearTimeout(timer); observer.disconnect() }
    }, [])
    return <div ref={ref} className="dbai-echarts" style={{ height: `${height}px` }} />
  }
)


/* ── Mermaid ── */

const MermaidImpl = createComponentImplementation(
  {
    name: 'Mermaid',
    description: 'Mermaid diagram (ER / flowchart / sequence). Provide the mermaid source code.',
    schema: z.object({
      code: DynamicStringSchema.describe('Mermaid diagram source')
    })
  },
  ({ props }) => {
    const ref = useRef(null)
    const themeKey = useThemeKey()
    const code = typeof props.code === 'string' ? props.code : ''
    useEffect(() => {
      const holder = ref.current
      if (!holder) return
      holder.dataset.code = code
      void renderMermaid(code, holder)
    }, [code, themeKey])
    return <div ref={ref} className="dbai-mermaid" data-code={code} />
  }
)

/* ── DbTable ── */

const fmtCell = (cell) => {
  if (cell === null || cell === undefined) return 'NULL'
  if (typeof cell === 'object') {
    try { return JSON.stringify(cell) } catch { return String(cell) }
  }
  return String(cell)
}

const DbTableImpl = createComponentImplementation(
  {
    name: 'DbTable',
    description: 'Interactive table for query results. Bind columns/rows via {"@path": "/toolResults/<n>/..."} to avoid echoing data in components.',
    schema: z.object({
      columns: DynamicValueSchema.describe('Column keys or {name,label} objects'),
      rows: DynamicValueSchema.describe('Row objects; keys match columns'),
      total: z.number().int().optional().describe('Total row count when rows are truncated'),
      caption: DynamicStringSchema.optional().describe('Optional caption above the table')
    })
  },
  ({ props }) => {
    const columns = useMemo(() => (props.columns || []).map((col) =>
      typeof col === 'string' ? { name: col, label: col } : { name: col?.name || '', label: col?.label || col?.name || '' }
    ), [props.columns])
    const [sort, setSort] = useState({ key: null, dir: 1 })
    const rows = useMemo(() => {
      const list = Array.isArray(props.rows) ? [...props.rows] : []
      if (sort.key) {
        list.sort((a, b) => {
          const av = a?.[sort.key]
          const bv = b?.[sort.key]
          if (av === bv) return 0
          if (av === null || av === undefined) return 1
          if (bv === null || bv === undefined) return -1
          const an = Number(av)
          const bn = Number(bv)
          if (!Number.isNaN(an) && !Number.isNaN(bn)) return (an - bn) * sort.dir
          return String(av).localeCompare(String(bv)) * sort.dir
        })
      }
      return list
    }, [props.rows, sort])
    const total = typeof props.total === 'number' ? props.total : rows.length
    return (
      <div className="dbai-dbtable">
        {props.caption ? <div className="dbai-dbtable-caption">{String(props.caption)}</div> : null}
        <div className="dbai-dbtable-scroll">
          <table className="dbai-dbtable-table">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col.name} onClick={() => setSort((s) => (s.key === col.name ? { key: col.name, dir: -s.dir } : { key: col.name, dir: 1 }))} className={sort.key === col.name ? `sorted ${sort.dir > 0 ? 'asc' : 'desc'}` : ''}>
                    {String(col.label)}{sort.key === col.name ? <span className="dbai-dbtable-arrow">{sort.dir > 0 ? '↑' : '↓'}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {columns.map((col) => {
                    const text = fmtCell(row?.[col.name])
                    return <td key={col.name} title={text}>{text.length > 64 ? `${text.slice(0, 64)}…` : text}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dbai-dbtable-foot">{total > rows.length ? `共 ${total} 行，已显示 ${rows.length} 行` : `共 ${rows.length} 行`}</div>
      </div>
    )
  }
)

/* ── SqlConfirm（app 专用，不进模型目录）── */

const SqlConfirmImpl = createComponentImplementation(
  {
    name: 'SqlConfirm',
    schema: z.object({
      tool: z.string(),
      summary: z.string(),
      sql: z.string().optional(),
      onConfirm: z.any().optional(),
      onCancel: z.any().optional(),
      onOpenInEditor: z.any().optional(),
      settled: z.string().optional()
    })
  },
  ({ props }) => {
    const settled = props.settled || ''
    return (
      <div className={`dbai-confirm ${settled}`}>
        <div className="dbai-confirm-head">
          <span className="dbai-confirm-badge">写操作确认</span>
          <code className="dbai-confirm-tool">{props.tool}</code>
        </div>
        <p className="dbai-confirm-summary">{props.summary}</p>
        {props.sql ? <pre className="dbai-confirm-sql">{props.sql}</pre> : null}
        <div className="dbai-confirm-actions">
          {props.sql && props.onOpenInEditor ? <button type="button" className="dbai-btn ghost" onClick={() => props.onOpenInEditor()}>在编辑器打开</button> : null}
          <span className="dbai-confirm-spacer" />
          <button type="button" className="dbai-btn" disabled={!!settled} onClick={() => props.onCancel?.()}>取消</button>
          <button type="button" className="dbai-btn primary" disabled={!!settled} onClick={() => props.onConfirm?.()}>执行</button>
        </div>
      </div>
    )
  }
)

/* ── 目录装配 ── */

export const dbAiCatalog = new Catalog(
  DB_AI_CATALOG_ID,
  '1.0',
  [EChartImpl, MermaidImpl, DbTableImpl, SqlConfirmImpl],
  [],
  undefined,
  '数据库 AI 助手专用组件：图表用 EChart(option 纯 JSON)或 Mermaid(code)；查询结果展示用 DbTable，columns/rows 用 @path 绑定 /toolResults 下已注入的数据，不要在 components 里回显大块数据。'
)

/** useThemeKey：主题切换时让图表组件重挂（信号驱动重画由 charts.mjs 内部状态保证） */
function useThemeKey() {
  const [key, setKey] = useState(() => (isDarkTheme() ? 'dark' : 'light'))
  useEffect(() => {
    const observer = new MutationObserver(() => setKey(isDarkTheme() ? 'dark' : 'light'))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'data-paper'] })
    return () => observer.disconnect()
  }, [])
  return key
}
