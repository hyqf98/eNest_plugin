import { Dialog, DialogContent, DialogTitle, Segmented, Select, Switch } from '../ui/index.jsx'

export function SettingsDialog({ open, settings, onChange, onClose }) {
  return (
    <Dialog open={open} onOpenChange={value => { if (!value) onClose() }}>
      <DialogContent className="sa-settings" aria-label="设置">
        <div className="sa-settings-head">
          <DialogTitle style={{ margin: 0 }}>设置</DialogTitle>
        </div>

        <div className="sa-setting-row">
          <span>截图后</span>
          <Segmented
            value={settings.captureAction}
            options={[{ value: 'preview', label: '预览' }, { value: 'copy', label: '复制' }, { value: 'pin', label: '贴图' }]}
            onChange={value => onChange('captureAction', value)}
            ariaLabel="截图后动作"
          />
        </div>

        <div className="sa-setting-row">
          <span>图片历史上限</span>
          <Select
            value={String(settings.imageLimit)}
            options={[{ value: '100', label: '100 条' }, { value: '200', label: '200 条' }, { value: '500', label: '500 条' }]}
            onChange={value => onChange('imageLimit', Number(value))}
            ariaLabel="图片历史上限"
            minWidth={100}
          />
        </div>

        <div className="sa-setting-row">
          <span>录屏默认录制声音</span>
          <Switch checked={settings.recordAudio} onCheckedChange={value => onChange('recordAudio', value)} aria-label="录屏默认录制声音" />
        </div>

        <div className="sa-setting-row">
          <span>GIF 默认帧率</span>
          <Select
            value={String(settings.gifFps)}
            options={[8, 10, 12, 15].map(value => ({ value: String(value), label: `${value} fps` }))}
            onChange={value => onChange('gifFps', Number(value))}
            ariaLabel="GIF 默认帧率"
            minWidth={100}
          />
        </div>

        <div className="sa-setting-row">
          <span>GIF 默认宽度</span>
          <Select
            value={String(settings.gifWidth)}
            options={[360, 480, 640, 720, 960].map(value => ({ value: String(value), label: `${value} px` }))}
            onChange={value => onChange('gifWidth', Number(value))}
            ariaLabel="GIF 默认宽度"
            minWidth={100}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
