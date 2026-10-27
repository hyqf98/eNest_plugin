/**
 * LeftRail — 左缘浮动图标轨道（overlay，不占画布布局宽度）。
 * 窄条常驻：节点库（hover 浮出面板）/ 添加节点 / 画廊 / 设置。
 * 节点项按 nodeSchema 的端口 kind 展示，新增节点自动出现在对应分类。
 */
import { useState } from 'react'
import { listNodeDefs, groupNodeDefs } from '../js/nodeRegistry.mjs'
import { PORT_KINDS } from '../js/nodeSchema.mjs'

const portGlyphs = ports => ports.map(p => PORT_KINDS[p.kind]?.glyph ?? '?').join('·')

export function LeftRail({ onAddNode, onOpenAddMenu, onOpenGallery, onOpenSettings, view }) {
  const [peek, setPeek] = useState(false)
  const groups = groupNodeDefs(listNodeDefs())

  return (
    <div className={`ac-rail ${peek ? 'ac-rail-peek' : ''}`}
      onMouseLeave={() => setPeek(false)}>
      <div className="ac-rail-strip" role="navigation" aria-label="画布工具轨道">
        <button type="button" className="ac-rail-btn" title="节点库（悬停展开）"
          onMouseEnter={() => setPeek(true)} onClick={() => setPeek(p => !p)}>
          <span aria-hidden>✧</span>
        </button>
        <button type="button" className="ac-rail-btn" title="添加节点" onClick={onOpenAddMenu}>
          <span aria-hidden>＋</span>
        </button>
        <button type="button" className={`ac-rail-btn ${view === 'gallery' ? 'ac-rail-active' : ''}`} title="画廊" onClick={onOpenGallery}>
          <span aria-hidden>▦</span>
        </button>
        <div className="ac-rail-spacer" />
        <button type="button" className="ac-rail-btn" title="设置" onClick={onOpenSettings}>
          <span aria-hidden>⚙</span>
        </button>
      </div>
      {peek && (
        <aside className="ac-rail-panel" onMouseEnter={() => setPeek(true)}>
          {groups.map(group => (
            <div key={group.category} className="ac-rail-group">
              <div className="ac-rail-group-title">{group.category}</div>
              {group.defs.map(def => (
                <div key={def.type} className="ac-rail-item" draggable
                  title={def.description || def.title}
                  onDragStart={e => { e.dataTransfer.setData('application/x-ai-canvas-node', def.type); e.dataTransfer.effectAllowed = 'move' }}
                  onClick={() => { onAddNode(def.type); setPeek(false) }}>
                  <span className="ac-glyph" aria-hidden>{def.glyph}</span>
                  <span className="ac-rail-item-title">{def.title}</span>
                  <span className="ac-rail-item-ports">
                    {def.inputs.length > 0 && <i>入 {portGlyphs(def.inputs)}</i>}
                    {def.outputs.length > 0 && <i>出 {portGlyphs(def.outputs)}</i>}
                  </span>
                </div>
              ))}
            </div>
          ))}
          <div className="ac-rail-hint">拖入画布或点击添加</div>
        </aside>
      )}
    </div>
  )
}
