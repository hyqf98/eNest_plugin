/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Select, Input } from '../ui/index.jsx'

export function SettingsDialog({ open, onClose, settings, onChange }) {
  const set = (key, value) => onChange(key, value)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="pk-set-dialog">
        <DialogTitle>时间戳设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认 IANA 时区</span>
              <span className="pk-set-note">如 Asia/Shanghai；无效时回退 UTC</span>
            </div>
            <div className="pk-set-control">
              <Input
                type="text"
                aria-label="默认 IANA 时区"
                value={settings.timeZone ?? 'Asia/Shanghai'}
                onChange={(e) => set('timeZone', e.target.value.trim())}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认输入单位</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="默认输入单位"
                value={settings.defaultUnit ?? 'auto'}
                options={[
                  { label: '自动识别', value: 'auto' },
                  { label: '秒', value: 's' },
                  { label: '毫秒', value: 'ms' },
                ]}
                onChange={(v) => set('defaultUnit', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">批量输出格式</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="批量输出格式"
                value={settings.batchFormat ?? 'date'}
                options={[
                  { label: '所选时区日期', value: 'date' },
                  { label: 'ISO UTC', value: 'iso' },
                  { label: '秒', value: 's' },
                  { label: '毫秒', value: 'ms' },
                ]}
                onChange={(v) => set('batchFormat', v)}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
