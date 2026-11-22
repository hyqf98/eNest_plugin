import { createElement, useEffect, useRef, useState } from 'react'
import { cachedImageDataUrl, loadImageBytes, copyImage } from '../js/api.mjs'
import { addFavorite, removeFavorite } from '../js/favorites.mjs'

/**
 * MemeCard — 表情卡片。
 * 交互：点击卡片任意位置 = 复制（一键复制）；hover 浮出 收藏/放大 小按钮。
 * 宽高按索引 width/height 精确预留（无跳动）；进入视口后拉缩略图直显。
 * GIF 角标左上、已收藏星标右上；复制中转圈、「已复制」徽标反馈。
 */
export function MemeCard({ item, isFavorite, onFavoriteChange, onZoom, showToast }) {
  const [dataUrl, setDataUrl] = useState(null)
  const [imgState, setImgState] = useState('pending') // pending | loading | done | error
  const [copyState, setCopyState] = useState('') // '' | 'busy' | 'done' | 'fail'
  const [favBusy, setFavBusy] = useState(false)
  const rootRef = useRef(null)

  // 拉图交给 loadImageBytes 的并发队列限流；此处再做视口门控会依赖
  // IntersectionObserver，而部分内嵌 webview 的 IO 不派发回调，导致占位卡永远
  // pending（页面"全是文字"）。队列上限 6 并发，60 张/页体量可控，直接加载。
  useEffect(() => {
    let alive = true
    ;(async () => {
      const url = item.thumbUrl || item.imageUrl
      try {
        const hit = cachedImageDataUrl(url)
        const loaded = hit ?? await loadImageBytes(url)
        if (alive) { setDataUrl(loaded); setImgState('done') }
      } catch {
        if (alive) setImgState('error')
      }
    })()
    return () => { alive = false }
  }, [])

  // 复制：点击卡片 → 拉原图（LRU）→ clipboard.writeImage
  async function handleCopy() {
    if (copyState === 'busy') return
    setCopyState('busy')
    try {
      const dataUrl = await loadImageBytes(item.imageUrl)
      const ok = await copyImage(dataUrl)
      if (!ok) throw new Error('写入剪贴板失败')
      setCopyState('done')
      showToast(item.animated ? '已复制动图（粘贴保动画）' : '已复制')
    } catch (err) {
      setCopyState('fail')
      showToast(`复制失败：${err.message || err}`, 'fail')
    } finally {
      setTimeout(() => setCopyState(state => (state === 'busy' ? '' : state === 'done' ? '' : state === 'fail' ? '' : state)), 1400)
    }
  }

  async function handleFavorite(e) {
    e.stopPropagation()
    if (favBusy) return
    setFavBusy(true)
    try {
      if (isFavorite) {
        await removeFavorite(item.id)
        onFavoriteChange(item.id)
        showToast('已取消收藏')
      } else {
        await addFavorite(item)
        onFavoriteChange(item.id)
        showToast('已收藏')
      }
    } catch (err) {
      showToast(`收藏失败：${err.message || err}`, 'fail')
    } finally {
      setFavBusy(false)
    }
  }

  const ratio = item.width > 0 && item.height > 0 ? item.width / item.height : 1
  return createElement('div', {
    ref: rootRef,
    className: `mm-card${copyState === 'done' ? ' is-copied' : ''}`,
    style: { aspectRatio: String(ratio) },
    onClick: handleCopy,
    title: `${item.label || ''} · 点击复制`,
  },
    createElement('div', { className: 'mm-card-media' },
      imgState === 'done' && dataUrl
        ? createElement('img', { src: dataUrl, alt: item.label || '表情包', draggable: false })
        : createElement('div', { className: `mm-card-ph${imgState === 'error' ? ' is-error' : ''}` },
            imgState === 'error' ? '加载失败' : createElement('span', { className: 'mm-spinner' }),
          ),
      item.animated && createElement('span', { className: 'mm-badge mm-badge-gif' }, 'GIF'),
      isFavorite && createElement('span', { className: 'mm-badge mm-badge-star' }, '★'),
    ),
    createElement('div', { className: 'mm-card-actions' },
      createElement('button', {
        type: 'button', className: `mm-act${isFavorite ? ' is-on' : ''}`, title: isFavorite ? '取消收藏' : '收藏',
        onClick: handleFavorite, disabled: favBusy,
      }, isFavorite ? '★' : '☆'),
      createElement('button', {
        type: 'button', className: 'mm-act', title: '放大',
        onClick: e => { e.stopPropagation(); onZoom(item) },
      }, '⤢'),
    ),
    copyState === 'done' && createElement('div', { className: 'mm-copied-badge' }, '已复制 ✓'),
    copyState === 'busy' && createElement('div', { className: 'mm-copied-badge is-busy' }, createElement('span', { className: 'mm-spinner' })),
    copyState === 'fail' && createElement('div', { className: 'mm-copied-badge is-fail' }, '复制失败'),
  )
}
