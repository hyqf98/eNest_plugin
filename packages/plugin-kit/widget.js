/** Optional, framework-neutral sizing for a widget's real content viewport. */
export function observeWidgetSize(element, onChange, { reservedHeight = 104, rowHeight = 32, maxRows = 8 } = {}) {
  let width = -1
  let height = -1
  let active = true
  const update = () => {
    if (!active) return
    const nextWidth = Math.max(0, Math.round(element.clientWidth))
    const nextHeight = Math.max(0, Math.round(element.clientHeight))
    if (width === nextWidth && height === nextHeight) return
    width = nextWidth
    height = nextHeight
    onChange({
      width,
      height,
      compact: width < 260 || height < 180,
      wide: width >= 360,
      rowLimit: Math.max(0, Math.min(maxRows, Math.floor((height - reservedHeight) / Math.max(1, rowHeight))))
    })
  }
  const observer = new ResizeObserver(update)
  observer.observe(element)
  update()
  return () => { active = false; observer.disconnect() }
}
