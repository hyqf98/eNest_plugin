/**
 * LeftRail — 左缘浮动图标轨道（overlay，不占画布布局宽度）。
 * 窄条常驻：节点库（仅悬停该按钮浮出面板）/ 添加节点 / 图片素材 / 设置。
 * 每个按钮 hover 即时浮出功能名（零延迟 CSS 提示）；悬停其他按钮时节点库面板收起。
 */
import { useRef, useState } from 'react'
import { listNodeDefs, groupNodeDefs } from '../js/nodeRegistry.mjs'

export function LeftRail({ onAddNode, onOpenAddMenu, onOpenGallery, onOpenSettings, view }) {
  const [peek, setPeek] = useState(false)
  const closeTimer = useRef(0)
  const groups = groupNodeDefs(listNodeDefs())

  // 移出轨道时留一点宽限：滑到浮层要跨过间隙，立即关闭会"够不着"
  const scheduleClose = () => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setPeek(false), 180)
  }
  const cancelClose = () => {
    window.clearTimeout(closeTimer.current)
    setPeek(true)
  }
  const closeNow = () => {
    window.clearTimeout(closeTimer.current)
    setPeek(false)
  }

  return (
    <div className={`ac-rail ${peek ? 'ac-rail-peek' : ''}`}
      onMouseLeave={scheduleClose}>
      <div className="ac-rail-strip" role="navigation" aria-label="画布工具轨道">
        <button type="button" className="ac-rail-btn"
          onMouseEnter={cancelClose} onClick={() => setPeek(p => !p)}>
          <span aria-hidden>✧</span>
          <span className="ac-rail-tip">节点库</span>
        </button>
        <button type="button" className="ac-rail-btn" onMouseEnter={closeNow} onClick={onOpenAddMenu}>
          <span aria-hidden>＋</span>
          <span className="ac-rail-tip">添加节点</span>
        </button>
        <button type="button" className={`ac-rail-btn ${view === 'gallery' ? 'ac-rail-active' : ''}`}
          onMouseEnter={closeNow} onClick={onOpenGallery}>
          <span aria-hidden>▦</span>
          <span className="ac-rail-tip">图片素材</span>
        </button>
        <div className="ac-rail-spacer" />
        <button type="button" className="ac-rail-btn" onMouseEnter={closeNow} onClick={onOpenSettings}>
          <span aria-hidden>⚙</span>
          <span className="ac-rail-tip">设置</span>
        </button>
      </div>
      {peek && (
        <aside className="ac-rail-panel" onMouseEnter={cancelClose}>
          {groups.map(group => (
            <div key={group.category} className="ac-rail-group">
              <div className="ac-rail-group-title">{group.category}</div>
              {group.defs.map(def => (
                <div key={def.type} className="ac-rail-item" draggable
                  title={def.description || def.title}
                  onDragStart={e => { e.dataTransfer.setData('application/x-ai-canvas-node', def.type); e.dataTransfer.effectAllowed = 'move' }}
                  onClick={e => { onAddNode(def.type, { x: e.clientX, y: e.clientY }); setPeek(false) }}>
                  <span className="ac-glyph" aria-hidden>{def.glyph}</span>
                  <span className="ac-rail-item-title">{def.title}</span>
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
