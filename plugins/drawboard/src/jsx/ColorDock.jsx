/**
 * ColorDock —— 悬浮在画布右上角的墨色切换
 * 收起时只露一个墨点；鼠标移入（或键盘聚焦）向左展开色板，移出自动收起。
 * 色板取当前纸感主题的 palette；「自动」恢复跟随主题墨色。
 */
export function ColorDock({ palette, color, themeInk, onChange }) {
  const current = color || themeInk
  return (
    <div className="db-colordock">
      <div className="db-colordock-panel" role="group" aria-label="墨色">
        <button
          type="button"
          className={`db-colordock-auto${color ? '' : ' active'}`}
          title="跟随主题墨色"
          aria-pressed={!color}
          onClick={() => onChange(null)}
        >自动</button>
        {palette.map((c) => (
          <button
            key={c}
            type="button"
            className={`db-colordock-swatch${c === current ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            aria-label={`墨色 ${c}`}
            aria-pressed={c === current}
            onClick={() => onChange(c === themeInk ? null : c)}
          />
        ))}
      </div>
      <button type="button" className="db-colordock-trigger" title="墨色（悬停展开）" aria-label="墨色（悬停展开）">
        <span className="db-colordock-dot" style={{ background: current }} />
      </button>
    </div>
  )
}
