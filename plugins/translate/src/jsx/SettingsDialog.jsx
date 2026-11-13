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
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="pk-set-dialog">
        <DialogTitle>翻译设置</DialogTitle>
        <div className="pk-set">
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认源语言</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="默认源语言"
                value={settings.srcLang ?? 'auto'}
                options={[
                  { label: '自动检测', value: 'auto' },
                  { label: '中文', value: 'zh-CN' },
                  { label: '英语', value: 'en' },
                  { label: '日语', value: 'ja' },
                  { label: '韩语', value: 'ko' },
                  { label: '法语', value: 'fr' },
                  { label: '德语', value: 'de' },
                  { label: '西班牙语', value: 'es' },
                  { label: '俄语', value: 'ru' },
                ]}
                onChange={(v) => set('srcLang', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认目标语言</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="默认目标语言"
                value={settings.tgtLang ?? 'zh-CN'}
                options={[
                  { label: '中文', value: 'zh-CN' },
                  { label: '英语', value: 'en' },
                  { label: '日语', value: 'ja' },
                  { label: '韩语', value: 'ko' },
                  { label: '法语', value: 'fr' },
                  { label: '德语', value: 'de' },
                  { label: '西班牙语', value: 'es' },
                  { label: '俄语', value: 'ru' },
                ]}
                onChange={(v) => set('tgtLang', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">默认引擎</span>
            </div>
            <div className="pk-set-control">
              <Select
                ariaLabel="默认引擎"
                value={settings.engine ?? 'auto'}
                options={[{ label: '自动', value: 'auto' }, { label: 'Google', value: 'google' }, { label: 'MyMemory', value: 'mymemory' }]}
                onChange={(v) => set('engine', v)}
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">暂停自动翻译（仅手动翻译）</span>
            </div>
            <div className="pk-set-control">
              <Switch
                checked={!!settings.autoTranslate}
                onCheckedChange={(v) => set('autoTranslate', v)}
                aria-label="暂停自动翻译（仅手动翻译）"
              />
            </div>
          </div>
          <div className="pk-set-row">
            <div className="pk-set-text">
              <span className="pk-set-label">桌面译文字号</span>
            </div>
            <div className="pk-set-control">
              <div className="pk-set-slider">
                <Slider
                  value={[Number(settings.resultFontSize) || 18]}
                  min={14}
                  max={24}
                  step={1}
                  onValueChange={([v]) => set('resultFontSize', v)}
                  aria-label="桌面译文字号"
                />
                <span className="pk-set-value">{Number(settings.resultFontSize) || 18}</span>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
