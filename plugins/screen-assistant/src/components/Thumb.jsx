import { useEffect, useRef, useState } from 'react'

const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/** 懒加载缩略图：进入视口后才向存储读取/补生成。 */
export function LazyThumb({ item, ensureThumb, alt = '', eager = false, className = '' }) {
  const [src, setSrc] = useState('')
  const [visible, setVisible] = useState(eager)
  const ref = useRef(null)

  useEffect(() => {
    if (eager || !ref.current || visible) return undefined
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '240px' })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [eager, visible])

  useEffect(() => {
    if (!visible) return undefined
    let alive = true
    Promise.resolve(ensureThumb(item))
      .then(url => { if (alive && url) setSrc(url) })
      .catch(() => {})
    return () => { alive = false }
  }, [visible, item, ensureThumb])

  return <img ref={ref} src={src || TRANSPARENT} alt={alt} className={className} draggable={false} />
}
