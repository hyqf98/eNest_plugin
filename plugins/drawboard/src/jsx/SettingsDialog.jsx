/**
 * SettingsDialog —— 插件内设置弹框：主题四选一 / 粗糙度 / 点阵网格
 * 右下角浮动圆钮进入；设置存插件私有存储，不注册壳全局设置。
 */
import { Dialog, DialogContent, DialogTitle, DialogDescription, Segmented, Slider, Switch } from '../ui/index.jsx'
import { THEMES } from '../js/theme.mjs'

export function SettingsFab({ onClick }) {
  return (
    <button type="button" className="db-fab" aria-label="画板设置" title="画板设置" onClick={onClick}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none" />
      </svg>
    </button>
  )
}

export function SettingsDialog({ open, onOpenChange, settings, setSettings }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="db-settings" aria-label="画板设置">
        <DialogTitle>画板设置</DialogTitle>
        <DialogDescription>纸感主题与手绘风格，仅本插件内生效。</DialogDescription>

        <div className="db-settings-row">
          <span className="db-settings-label">纸感主题</span>
          <div className="db-theme-grid" role="radiogroup" aria-label="纸感主题">
            {Object.values(THEMES).map((t) => (
              <button
                key={t.id}
                type="button"
                className={`db-theme-card${settings.theme === t.id ? ' active' : ''}`}
                role="radio"
                aria-checked={settings.theme === t.id}
                style={{ background: t.paper }}
                onClick={() => setSettings({ ...settings, theme: t.id })}
              >
                <span className="db-theme-line" style={{ background: t.palette[0] }} />
                <span className="db-theme-line short" style={{ background: t.palette[5] }} />
                <span className="db-theme-name">{t.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="db-settings-row">
          <span className="db-settings-label">手绘粗糙度</span>
          <div className="db-settings-control">
            <Slider
              value={[settings.roughness]}
              min={0} max={2} step={0.25}
              onValueChange={([v]) => setSettings({ ...settings, roughness: v })}
              aria-label="手绘粗糙度"
            />
            <span className="db-settings-value">{settings.roughness === 0 ? '规整' : settings.roughness >= 1.75 ? '奔放' : settings.roughness.toFixed(2)}</span>
          </div>
        </div>

        <div className="db-settings-row">
          <span className="db-settings-label">点阵网格</span>
          <Switch checked={settings.grid === 'dots'} onCheckedChange={(on) => setSettings({ ...settings, grid: on ? 'dots' : 'none' })} aria-label="点阵网格" />
        </div>
      </DialogContent>
    </Dialog>
  )
}
