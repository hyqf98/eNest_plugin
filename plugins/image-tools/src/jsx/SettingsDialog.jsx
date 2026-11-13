/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Select, Slider, Switch } from '../ui/index.jsx'

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
  const targetKb = Number(settings.targetKb) || 200
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="pk-set-dialog">
        <DialogTitle>图片工具箱设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">跟随壳子主题</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="跟随壳子主题"
                checked={settings.followShellTheme !== false}
                onCheckedChange={(v) => set('followShellTheme', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">Quick 快速压缩目标体积（KB）</span>
            </div>
            <div className="pk-set-control">
              <div className="pk-set-slider">
                <Slider
                  aria-label="Quick 快速压缩目标体积"
                  min={20} max={2048} step={20}
                  value={[targetKb]}
                  onValueChange={([v]) => set('targetKb', v)}
                />
                <span className="pk-set-value">{targetKb} KB</span>
              </div>
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">Quick 快速压缩格式</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="Quick 快速压缩格式"
                value={settings.quickFormat ?? 'image/jpeg'}
                options={[{ label: 'JPEG', value: 'image/jpeg' }, { label: 'WebP', value: 'image/webp' }]}
                onChange={(v) => set('quickFormat', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">压缩完成后自动贴图预览</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="压缩完成后自动贴图预览"
                checked={settings.autoPin === true}
                onCheckedChange={(v) => set('autoPin', v)}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
