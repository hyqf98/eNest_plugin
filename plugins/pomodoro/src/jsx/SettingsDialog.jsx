/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Input, Select, Switch } from '../ui/index.jsx'

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

function NumberRow({ label, value, min, max, onChange }) {
  return (
    <div className="pk-set-row">
      <div className="pk-set-text">
        <span className="pk-set-label">{label}</span>
      </div>
      <div className="pk-set-control">
        <Input
          type="number" min={String(min)} max={String(max)} step="1"
          aria-label={label}
          value={value}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (Number.isFinite(next) && next >= min && next <= max) onChange(Math.round(next))
          }}
        />
      </div>
    </div>
  )
}

function SwitchRow({ label, checked, onChange }) {
  return (
    <div className="pk-set-row">
      <div className="pk-set-text">
        <span className="pk-set-label">{label}</span>
      </div>
      <div className="pk-set-control">
        <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
      </div>
    </div>
  )
}

export function SettingsDialog({ open, onClose, settings, onChange }) {
  const set = (key, value) => onChange(key, value)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="pk-set-dialog">
        <DialogTitle>番茄钟设置</DialogTitle>
        <div className="pk-set">
          <NumberRow label="默认专注分钟" value={settings.focusMin ?? 25} min={1} max={180} onChange={(v) => set('focusMin', v)} />
          <NumberRow label="默认短休息分钟" value={settings.breakMin ?? 5} min={1} max={60} onChange={(v) => set('breakMin', v)} />
          <NumberRow label="长休息分钟" value={settings.longBreakMin ?? 15} min={1} max={120} onChange={(v) => set('longBreakMin', v)} />
          <NumberRow label="每几轮长休息" value={settings.longBreakEvery ?? 4} min={2} max={12} onChange={(v) => set('longBreakEvery', v)} />
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">时长预设</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="时长预设"
                value={settings.preset ?? '25,5'}
                options={[
                  { label: '25 / 5 经典', value: '25,5' },
                  { label: '50 / 10 深度', value: '50,10' },
                  { label: '15 / 3 短冲刺', value: '15,3' },
                  { label: '自定义', value: '' },
                ]}
                onChange={(v) => set('preset', v)}
              />
            </div>
          </div>
          <SwitchRow label="阶段完成播放提示音" checked={settings.sound ?? true} onChange={(v) => set('sound', v)} />
          <SwitchRow label="阶段结束自动开始下一阶段" checked={settings.autoStart ?? false} onChange={(v) => set('autoStart', v)} />
          <SwitchRow label="阶段完成时发送系统通知" checked={settings.notify ?? true} onChange={(v) => set('notify', v)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
