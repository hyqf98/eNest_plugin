/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Select, Input, Switch } from '../ui/index.jsx'

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
        <DialogTitle>剪贴板设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">监控剪贴板</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="监控剪贴板"
                checked={settings.monitoring !== false}
                onCheckedChange={(v) => set('monitoring', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">历史容量（条）</span>
            </div>
            <div className="pk-set-control">
              <Input
                type="number" min="50" max="10000" step="1"
                aria-label="历史容量（条）"
                value={settings.historyLimit ?? 200}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (Number.isFinite(next) && next >= 50 && next <= 10000) set('historyLimit', next)
                }}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">保留天数（0 为不限）</span>
            </div>
            <div className="pk-set-control">
              <Input
                type="number" min="0" max="3650" step="1"
                aria-label="保留天数（0 为不限）"
                value={settings.retentionDays ?? 0}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (Number.isFinite(next) && next >= 0 && next <= 3650) set('retentionDays', next)
                }}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">记录系统可识别的来源应用</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="记录系统可识别的来源应用"
                checked={settings.recordSource !== false}
                onCheckedChange={(v) => set('recordSource', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">Enter 默认操作</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="Enter 默认操作"
                value={settings.defaultAction ?? 'paste'}
                options={[{ label: '回贴到呼出前的应用', value: 'paste' }, { label: '复制到剪贴板', value: 'copy' }]}
                onChange={(v) => set('defaultAction', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">历史列表密度</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="历史列表密度"
                value={settings.density ?? 'comfortable'}
                options={[{ label: '舒适', value: 'comfortable' }, { label: '紧凑', value: 'compact' }]}
                onChange={(v) => set('density', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">排除应用（逗号分隔）</span>
            </div>
            <div className="pk-set-control">
              <Input
                style={{ width: 220 }}
                aria-label="排除应用（逗号分隔）"
                placeholder="应用名称或应用 ID"
                value={settings.excludedApps ?? ''}
                onChange={(e) => set('excludedApps', e.target.value)}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
