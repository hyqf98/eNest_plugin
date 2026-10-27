/**
 * Toolbar —— 精简顶栏：当前颜色按钮（点击弹色盘）/ 撤销 / 重做
 * 其余能力（工具切换、笔宽、插入图片）全部收进右键菜单。
 */
import { Tooltip } from '../ui/index.jsx'

export function Toolbar({ theme, settings, onOpenColorPicker, canUndo, canRedo, onUndo, onRedo }) {
  const inkColor = settings.color || theme.ink
  return (
    <div className="db-toolbar">
      <Tooltip content="墨色（点击换色）" side="bottom">
        <button
          type="button"
          className="db-color-trigger"
          aria-label="墨色（点击换色）"
          onClick={onOpenColorPicker}
        >
          <span className="db-color-dot" style={{ background: inkColor }} />
          <span className="db-color-ring" style={{ borderColor: inkColor }} aria-hidden="true" />
        </button>
      </Tooltip>
      <div className="db-spacer" />
      <div className="db-toolbar-group">
        <Tooltip content="撤销 ⌘Z" side="bottom">
          <button type="button" className="db-tool" onClick={onUndo} disabled={!canUndo} aria-label="撤销"><svg style={{ display: 'block' }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-4" /></svg></button>
        </Tooltip>
        <Tooltip content="重做 ⌘⇧Z" side="bottom">
          <button type="button" className="db-tool" onClick={onRedo} disabled={!canRedo} aria-label="重做"><svg style={{ display: 'block' }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h4" /></svg></button>
        </Tooltip>
      </div>
    </div>
  )
}
