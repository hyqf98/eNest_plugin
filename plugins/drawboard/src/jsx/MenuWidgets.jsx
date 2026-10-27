/**
 * MenuWidgets —— 右键菜单内嵌控件：色盘（swatch 网格 + 自定义取色）与数值滑条
 * 挂在 CascadeMenu 的独立 React 树里：菜单树不随 App 重渲，
 * 因此控件用内部 state 驱动显示，onChange 同步给 App（画布实时生效）。
 */
import { useEffect, useState } from 'react'

export function MenuColorPicker({ palette, current, onPick }) {
  const [picked, setPicked] = useState(current)
  useEffect(() => { if (current !== picked) setPicked(current) }, [current]) // eslint-disable-line
  return (
    <div className="db-menu-picker" onClick={(e) => e.stopPropagation()} role="group" aria-label="选择颜色">
      <div className="db-picker-grid">
        {palette.map((c) => (
          <button
            key={c}
            type="button"
            className={`db-picker-swatch${picked === c ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            aria-label={`墨色 ${c}`}
            aria-pressed={picked === c}
            onClick={() => { setPicked(c); onPick(c) }}
          />
        ))}
        <label
          className={`db-picker-swatch db-picker-custom${/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(picked) && !palette.includes(picked) ? ' active' : ''}`}
          title="自定义颜色"
        >
          <input
            type="color"
            aria-label="自定义颜色"
            value={/^#[0-9a-f]{6}$/i.test(picked) ? picked : '#888888'}
            onChange={(e) => { setPicked(e.target.value); onPick(e.target.value) }}
          />
          <span className="db-picker-plus" aria-hidden="true">+</span>
        </label>
      </div>
    </div>
  )
}

export function MenuSlider({ label, value, min, max, step, onChange, format }) {
  const [v, setV] = useState(value)
  return (
    <div className="db-menu-slider" onClick={(e) => e.stopPropagation()} role="group" aria-label={label}>
      <div className="db-menu-slider-head">
        <span>{label}</span>
        <span className="db-menu-slider-value">{format ? format(v) : v}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={v}
        onChange={(e) => { const n = Number(e.target.value); setV(n); onChange(n) }}
        aria-label={label}
      />
    </div>
  )
}
