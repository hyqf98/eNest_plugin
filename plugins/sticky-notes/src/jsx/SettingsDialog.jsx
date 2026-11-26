/** 插件内设置弹窗：storage 自存（kit.setPref 即时生效），不再注册壳设置页。 */
import { Dialog, DialogContent, DialogTitle, Select } from '../ui/index.jsx'

export function SettingsDialog({ open, onClose, settings, onChange }) {
  const set = (key, value) => onChange(key, value)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="pk-set-dialog">
        <DialogTitle>备忘录设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">新笔记颜色</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="新笔记颜色"
                value={settings.defaultColor ?? '#cfa467'}
                options={[
                  { label: '麦黄', value: '#cfa467' },
                  { label: '青绿', value: '#7fa894' },
                  { label: '暖红', value: '#b78180' },
                  { label: '雾蓝', value: '#7b9ebc' },
                  { label: '藤紫', value: '#a592b7' },
                ]}
                onChange={(v) => set('defaultColor', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">桌面笔记视图</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="桌面笔记视图"
                value={settings.defaultLayout ?? 'list'}
                options={[
                  { label: '列表', value: 'list' },
                  { label: '卡片', value: 'grid' },
                ]}
                onChange={(v) => set('defaultLayout', v)}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
