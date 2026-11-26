/**
 * useMasonry — 把一组条目按「最短列优先」分进 N 列，形成真正的瀑布流。
 *
 * 为什么不用 CSS 多列或 Grid：
 * - 多列（columns）在容器有确定高度时，放不下的内容会往「右边」生成新列而不是往下排；
 * - Grid 的同一行格子等高，一张竖图会把整行撑高，旁边留下大片空白。
 * 两者都不是瀑布流。这里用 JS 量每列累计高度，把每个条目放进当前最矮的一列。
 *
 * 用法：const { containerRef, columns, onItemHeight } = useMasonry(items, { minColumnWidth: 220, gap: 14 })
 *   columns: 二维数组，每个外层元素是一列里的条目
 *   onItemHeight(item, height)：条目渲染/图片解码后上报自身高度，触发重新分配
 * 高度按条目 id 记，筛选、搜索、翻页后已量过的卡片不用重量。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/** 未测量时的估算高度：方图占位（列宽）+ 标题行 */
const DEFAULT_HEIGHT = 335

export function useMasonry(items, { minColumnWidth = 220, gap = 14 } = {}) {
  const [container, setContainer] = useState(null)   // 回调 ref：容器挂载/卸载时触发
  const heightsRef = useRef(new Map())     // id → measured height
  const [columnCount, setColumnCount] = useState(1)
  const [, bump] = useState(0)

  /* 列数：按容器宽度算，宽度变化时重算。
     必须跟着「容器什么时候出现」走：灵感页刚切进来时先渲染骨架屏，列容器要等数据到了才有。
     普通的 ref 对象不会因为容器后来才挂载而触发重渲染，列数会一直停在初始的 1。 */
  useLayoutEffect(() => {
    if (!container) return
    const measure = () => setColumnCount(Math.max(1, Math.floor((container.clientWidth + gap) / (minColumnWidth + gap))))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    return () => ro.disconnect()
  }, [container, minColumnWidth, gap])

  const columns = useMemo(() => {
    const heights = heightsRef.current
    const cols = Array.from({ length: columnCount }, () => [])
    const totals = new Array(columnCount).fill(0)
    items.forEach((item) => {
      let best = 0
      for (let c = 1; c < columnCount; c += 1) if (totals[c] < totals[best]) best = c
      cols[best].push(item)
      totals[best] += (heights.get(item.id) ?? DEFAULT_HEIGHT) + gap   // 未测量时按常见卡片高度估
    })
    return cols
  }, [items, columnCount, gap])   // heights 是可变引用：靠 onItemHeight 里的 bump 触发重算

  /* 只保留当前数据集里还在的 id，避免筛选、搜索切换后无限增长 */
  useEffect(() => {
    const heights = heightsRef.current
    const live = new Set(items.map((item) => item.id))
    for (const id of heights.keys()) if (!live.has(id)) heights.delete(id)
  }, [items])

  /* 条目上报高度：变化时记下并触发重新分配 */
  const onItemHeight = useCallback((item, height) => {
    if (!height || heightsRef.current.get(item.id) === height) return
    heightsRef.current.set(item.id, height)
    bump((n) => n + 1)
  }, [])

  return { containerRef: setContainer, columns, onItemHeight, gap }
}
