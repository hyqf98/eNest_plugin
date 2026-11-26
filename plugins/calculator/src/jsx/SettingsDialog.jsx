/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Select, Input } from '../ui/index.jsx'

export function SettingsDialog({ open, onClose, settings, onChange }) {
  const set = (key, value) => onChange(key, value)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="pk-set-dialog">
        <DialogTitle>计算器设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">显示有效数字</span>
            </div>
            <div className="pk-set-control">
              <Input
                type="number" min="1" max="16" step="1"
                aria-label="显示有效数字"
                value={settings.precision ?? 12}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (Number.isFinite(next) && next >= 1 && next <= 16) set('precision', next)
                }}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">保留未收藏记录数</span>
            </div>
            <div className="pk-set-control">
              <Input
                type="number" min="20" max="500" step="10"
                aria-label="保留未收藏记录数"
                value={settings.historyLimit ?? 100}
                onChange={(e) => {
                  const next = Number(e.target.value)
                  if (Number.isFinite(next) && next >= 20 && next <= 500) set('historyLimit', next)
                }}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认角度单位</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="默认角度单位"
                value={settings.angleUnit ?? 'rad'}
                options={[{ label: '弧度 RAD', value: 'rad' }, { label: '角度 DEG', value: 'deg' }]}
                onChange={(v) => set('angleUnit', v)}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
