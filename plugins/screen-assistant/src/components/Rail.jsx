import { Icon } from './Icon.jsx'

const ITEMS = [
  { id: 'capture', icon: 'capture', label: '拍摄' },
  { id: 'library', icon: 'library', label: '媒体库' },
  { id: 'tools', icon: 'tools', label: '工具箱' },
  { id: 'pins', icon: 'pin', label: '贴图' }
]

export function Rail({ view, onChange, onSettings, pinCount = 0, libraryCount = 0 }) {
  return (
    <nav className="sa-rail" aria-label="主要导航">
      {ITEMS.map(item => (
        <button
          key={item.id}
          type="button"
          className="sa-rail-btn"
          data-active={view === item.id}
          aria-label={item.label}
          aria-pressed={view === item.id}
          title={item.label}
          onClick={() => onChange(item.id)}
        >
          <Icon name={item.icon} />
          {item.id === 'pins' && pinCount > 0 ? <span className="sa-rail-badge">{pinCount > 99 ? '99+' : pinCount}</span> : null}
          {item.id === 'library' && libraryCount > 0 && view !== 'library' ? <span className="sa-rail-badge">{libraryCount > 99 ? '99+' : libraryCount}</span> : null}
        </button>
      ))}
      <span className="sa-rail-spacer" />
      <button type="button" className="sa-rail-btn" aria-label="设置" title="设置" onClick={onSettings}>
        <Icon name="settings" />
      </button>
    </nav>
  )
}
