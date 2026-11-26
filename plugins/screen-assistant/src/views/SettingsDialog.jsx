import { useState } from 'react'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogTitle, Segmented, Select, Switch } from '../ui/index.jsx'
import { Icon } from '../components/Icon.jsx'
import { CAPTURE_ACTIONS } from './CaptureView.jsx'

const SECTIONS = [{ value: 'image', label: '截图' }, { value: 'record', label: '录屏' }, { value: 'gif', label: 'GIF 导出' }]

export function SettingsDialog({ initialSection, settings, onChange, onClose }) {
  const [section, setSection] = useState(initialSection)
  return (
    <Dialog open onOpenChange={value => { if (!value) onClose() }}>
      <DialogOverlay />
      <DialogContent className="sa-settings" aria-describedby={undefined}>
        <div className="sa-settings-head">
          <DialogTitle>屏幕助手设置</DialogTitle>
          <DialogClose asChild><button type="button" className="sa-icon-btn" aria-label="关闭设置"><Icon name="close" /></button></DialogClose>
        </div>
        <Segmented value={section} options={SECTIONS} onChange={setSection} ariaLabel="设置分类" />

        {section === 'image' && <>
          <div className="sa-setting-row">
            <span>截图后</span>
            <Segmented value={settings.captureAction} options={CAPTURE_ACTIONS} onChange={value => onChange('captureAction', value)} ariaLabel="截图后动作" />
          </div>
          <div className="sa-setting-row">
            <span>图片历史上限</span>
            <Select
              value={String(settings.imageLimit)}
              options={[{ value: '100', label: '100 条' }, { value: '200', label: '200 条' }, { value: '500', label: '500 条' }]}
              onChange={value => onChange('imageLimit', Number(value))}
              ariaLabel="图片历史上限" minWidth={100}
            />
          </div>
        </>}
        {section === 'record' && (
          <div className="sa-setting-row">
            <span>录制系统声音</span>
            <Switch checked={settings.recordAudio === true} onCheckedChange={value => onChange('recordAudio', value)} aria-label="录制系统声音" />
          </div>
        )}
        {section === 'gif' && <>
          <div className="sa-setting-row">
            <span>默认帧率</span>
            <Select
              value={String(settings.gifFps)}
              options={[8, 10, 12, 15].map(value => ({ value: String(value), label: `${value} fps` }))}
              onChange={value => onChange('gifFps', Number(value))}
              ariaLabel="GIF 默认帧率" minWidth={100}
            />
          </div>
          <div className="sa-setting-row">
            <span>默认宽度</span>
            <Select
              value={String(settings.gifWidth)}
              options={[360, 480, 640, 720, 960].map(value => ({ value: String(value), label: `${value} px` }))}
              onChange={value => onChange('gifWidth', Number(value))}
              ariaLabel="GIF 默认宽度" minWidth={100}
            />
          </div>
        </>}
      </DialogContent>
    </Dialog>
  )
}
