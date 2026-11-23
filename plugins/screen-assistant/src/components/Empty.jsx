import { Icon } from './Icon.jsx'

export function Empty({ icon = 'image', text, children }) {
  return (
    <div className="sa-empty">
      <Icon name={icon} />
      <span>{text}</span>
      {children}
    </div>
  )
}
