import { Icon } from './Icon.jsx'

export function Empty({ icon = 'image', text, children }) {
  return (
    <div className="pk-empty-state">
      <Icon name={icon} />
      <strong className="pk-empty-title">{text}</strong>
      {children}
    </div>
  )
}
