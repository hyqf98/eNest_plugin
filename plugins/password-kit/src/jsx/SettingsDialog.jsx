/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Input, Switch } from '../ui/index.jsx'

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
        <DialogTitle>密码工具箱设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认密码长度</span>
            </div>
            <div className="pk-set-control">
              <Input
                type="number" min="6" max="128" step="1"
                aria-label="默认密码长度"
                value={settings.defaultLength ?? 16}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (Number.isFinite(next) && next >= 6 && next <= 128) set('defaultLength', Math.round(next))
                }}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">排除易混淆字符</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="排除易混淆字符"
                checked={settings.avoidAmbiguous ?? false}
                onCheckedChange={(v) => set('avoidAmbiguous', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认遮罩密码</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="默认遮罩密码"
                checked={settings.maskResults ?? true}
                onCheckedChange={(v) => set('maskResults', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">UUID 大写字母</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="UUID 大写字母"
                checked={settings.uuidUppercase ?? false}
                onCheckedChange={(v) => set('uuidUppercase', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">UUID 保留连字符</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="UUID 保留连字符"
                checked={settings.uuidHyphens ?? true}
                onCheckedChange={(v) => set('uuidHyphens', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">保留生成历史（仅本地存储）</span>
            </div>
            <div className="pk-set-control">
              <Switch
                aria-label="保留生成历史（仅本地存储）"
                checked={settings.keepHistory ?? true}
                onCheckedChange={(v) => set('keepHistory', v)}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
