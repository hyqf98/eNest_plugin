/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Select, Switch } from '../ui/index.jsx'

const GEAR = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export function SettingsGear({ onClick, className = '' }) {
  return (
    <button type="button" className={`pk-btn pk-btn-ghost pk-set-trigger${className ? ` ${className}` : ''}`} title="设置" aria-label="打开设置" onClick={onClick}>
      {GEAR}
    </button>
  )
}

export function SettingsDialog({ open, onClose, settings, onChange }) {
  const set = (key, value) => onChange(key, value)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="pk-set-dialog">
        <DialogTitle>供应商切换设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认应用</span>
              <span className="pk-set-note">Quick 切换与启动时的默认应用</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="默认应用"
                value={settings.defaultApp ?? 'claude-code'}
                options={[{ label: 'Claude Code', value: 'claude-code' }, { label: 'Codex CLI', value: 'codex' }, { label: 'Gemini CLI', value: 'gemini-cli' }]}
                onChange={(v) => set('defaultApp', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">切换前显示 diff 确认</span>
              <span className="pk-set-note">关闭后一键直接切换（仍自动快照）</span>
            </div>
            <div className="pk-set-control">
              <Switch
                checked={settings.diffConfirm !== false}
                onCheckedChange={(v) => set('diffConfirm', v)}
                aria-label="切换前显示 diff 确认"
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">备份保留策略</span>
              <span className="pk-set-note">插件后端自动快照，每应用保留最近 20 份</span>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
