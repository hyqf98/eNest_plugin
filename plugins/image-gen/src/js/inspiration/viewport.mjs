const galleries = new WeakMap()
const margin = 400

export function observeCover(element, update) {
  const root = element.closest('.ig-insp-masonry')
  const scroller = root ?? window
  let gallery = galleries.get(scroller)
  if (!gallery) {
    const targets = new Map()
    let timer
    const measure = (node, bounds) => {
      const rect = node.getBoundingClientRect()
      targets.get(node)?.(rect.height > 0 && rect.bottom >= (bounds?.top ?? 0) - margin
        && rect.top <= (bounds?.bottom ?? window.innerHeight) + margin)
    }
    const scan = () => {
      timer = undefined
      const bounds = root?.getBoundingClientRect()
      for (const node of targets.keys()) measure(node, bounds)
    }
    const schedule = () => { if (timer === undefined) timer = setTimeout(scan, 180) }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      for (const entry of entries) targets.get(entry.target)?.(entry.isIntersecting)
    }, { root, rootMargin: `${margin}px` })
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    gallery = { targets, observer, measure, dispose() {
      observer?.disconnect()
      clearTimeout(timer)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    } }
    galleries.set(scroller, gallery)
  }
  gallery.targets.set(element, update)
  gallery.measure(element, root?.getBoundingClientRect())
  gallery.observer?.observe(element)
  return () => {
    gallery.targets.delete(element)
    gallery.observer?.unobserve(element)
    if (!gallery.targets.size) { gallery.dispose(); galleries.delete(scroller) }
  }
}
