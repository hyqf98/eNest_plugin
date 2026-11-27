/** 本插件用到的线性图标；与官方插件一致：内联 SVG、1.7 描边、currentColor，不引入图标库。 */
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }

const svg = (props, children, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base} {...props}>{children}</svg>
)

export const ChevronLeft = (p) => svg(p, <path d="m15 6-6 6 6 6" />)
export const ChevronRight = (p) => svg(p, <path d="m9 6 6 6-6 6" />)
export const ChevronDown = (p) => svg(p, <path d="m6 9 6 6 6-6" />)
export const CalendarDays = (p) => svg(p, <>
  <rect x="3" y="5" width="18" height="16" rx="2.5" />
  <path d="M3 10h18M8 3v4M16 3v4" />
  <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" />
</>)
export const Palette = (p) => svg(p, <>
  <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.8-1.9 0-.6-.25-1.1-.55-1.5-.3-.4-.5-.85-.5-1.35 0-1.1.9-1.9 1.9-1.9H16a5 5 0 0 0 5-5c0-3.6-4-6.35-9-6.35Z" />
  <circle cx="7.5" cy="11.5" r=".9" /><circle cx="10.5" cy="7.5" r=".9" /><circle cx="15" cy="7.5" r=".9" />
</>)
export const Settings = (p) => svg(p, <>
  <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
</>)
export const Search = (p) => svg(p, <>
  <circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" />
</>)
export const X = (p) => svg(p, <path d="M6 6l12 12M18 6 6 18" />)
export const Plus = (p) => svg(p, <path d="M12 5v14M5 12h14" />)
export const Refresh = (p) => svg(p, <>
  <path d="M20 11a8 8 0 1 0-2.3 6.3" /><path d="M20 4v7h-7" />
</>)
export const External = (p) => svg(p, <>
  <path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10" />
</>)
export const Grip = (p) => svg(p, <>
  <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" strokeWidth={2.4} />
</>)
export const ArrowUp = (p) => svg(p, <path d="m6 14 6-6 6 6" />)
export const ArrowDown = (p) => svg(p, <path d="m6 10 6 6 6-6" />)
export const Sun = (p) => svg(p, <>
  <circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
</>)
export const Cloud = (p) => svg(p, <>
  <path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5a4 4 0 0 1-.5 8H7Z" />
</>)
export const Info = (p) => svg(p, <>
  <circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
</>)
export const Pin = (p) => svg(p, <>
  <path d="M9 4h6l-1 6 3.5 3.5v1.5h-11V13.5L10 10 9 4Z" /><path d="M12 15v6" />
</>)
