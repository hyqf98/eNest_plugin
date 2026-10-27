/**
 * LeftRail — 左缘浮动图标轨道（overlay，不占画布布局宽度）。
 * 窄条常驻：节点库（hover 浮出面板）/ 画廊 / 设置；todos peek 模式（absolute + 阴影覆盖）。
 */
import { useState } from 'react'
import { listNodeDefs } from '../js/nodeRegistry.mjs'

export function LeftRail({ onAddNode, onOpenGallery, onOpenSettings, view }) {
  const [peek, setPeek] = useState(false)
  const defs = listNodeDefs()
  const groups = [...new Set(defs.map(d => d.category))]

  return (
    <div className={`ac-rail ${peek ? 'ac-rail-peek' : ''}`}
      onMouseLeave={() => setPeek(false)}>
      <div className="ac-rail-strip" role="navigation" aria-label="画布工具轨道">
        <button type="button" className="ac-rail-btn" title="节点库（悬停展开）"
          onMouseEnter={() => setPeek(true)} onClick={() => setPeek(p => !p)}>
          <span aria-hidden>✧</span>
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
            <div key={group} className="ac-rail-group">
              <div className="ac-rail-group-title">{group}</div>
              {defs.filter(d => d.category === group).map(def => (
                <div key={def.type} className="ac-rail-item" draggable
                  onDragStart={e => { e.dataTransfer.setData('application/x-ai-canvas-node', def.type); e.dataTransfer.effectAllowed = 'move' }}
                  onClick={() => { onAddNode(def.type); setPeek(false) }}>
                  <span className="ac-glyph" aria-hidden>{def.glyph}</span>
                  <span className="ac-rail-item-title">{def.title}</span>
                  <span className="ac-rail-item-ports">
                    {def.inputs.length > 0 && <i>入 {def.inputs.map(p => p.kind === 'image' ? '图' : '文').join('·')}</i>}
                    {def.outputs.length > 0 && <i>出 {def.outputs.map(p => p.kind === 'image' ? '图' : '文').join('·')}</i>}
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
