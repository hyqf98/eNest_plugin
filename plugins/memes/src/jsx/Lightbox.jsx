import { createElement, useEffect, useState } from 'react'
import { loadImageBytes, copyImage } from '../js/api.mjs'
import { addFavorite, removeFavorite } from '../js/favorites.mjs'

/**
 * Lightbox — 大图预览：原图、复制、收藏、信息条（label/尺寸/来源）。
 * Esc/点击遮罩关闭；左右方向键在多图间切换（放大上下文里）。
 * overrideDataUrl：已有 dataUrl（如收藏条目）时直接显示，跳过网络加载。
 */
export function Lightbox({ item, isFavorite, onFavoriteChange, onClose, showToast, onNav, overrideDataUrl }) {
  const [dataUrl, setDataUrl] = useState(overrideDataUrl ?? null)
  const [state, setState] = useState(overrideDataUrl ? 'done' : 'loading')
  const [copyState, setCopyState] = useState('')

  useEffect(() => {
    let alive = true
    if (overrideDataUrl) { setDataUrl(overrideDataUrl); setState('done'); return }
    setState('loading')
    setDataUrl(null)
    ;(async () => {
      try {
        const url = await loadImageBytes(item.imageUrl)
        if (alive) { setDataUrl(url); setState('done') }
      } catch {
        if (alive) setState('error')
      }
    })()
    return () => { alive = false }
  }, [item.id, overrideDataUrl])

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onNav?.(-1)
      else if (e.key === 'ArrowRight') onNav?.(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNav])

  async function handleCopy() {
    if (!dataUrl || copyState === 'busy') return
    setCopyState('busy')
    try {
      const ok = await copyImage(dataUrl)
      if (!ok) throw new Error('写入剪贴板失败')
      setCopyState('done')
      showToast('已复制')
    } catch (err) {
      setCopyState('fail')
      showToast(`复制失败：${err.message || err}`, 'fail')
    } finally {
      setTimeout(() => setCopyState(''), 1400)
    }
  }

  async function handleFavorite() {
    try {
      if (isFavorite) {
        await removeFavorite(item.id)
        onFavoriteChange(item.id)
        showToast('已取消收藏')
      } else {
        await addFavorite(item, dataUrl ?? undefined)
        onFavoriteChange(item.id)
        showToast('已收藏')
      }
    } catch (err) {
      showToast(`收藏失败：${err.message || err}`, 'fail')
    }
  }

  return createElement('div', { className: 'mm-lightbox', onClick: onClose },
    createElement('div', { className: 'mm-lightbox-stage', onClick: e => e.stopPropagation() },
      createElement('button', { type: 'button', className: 'mm-lightbox-close', onClick: onClose, title: '关闭 (Esc)' }, '×'),
      state === 'loading' && createElement('div', { className: 'mm-lightbox-loading' },
        createElement('span', { className: 'mm-spinner mm-spinner-lg' }), createElement('span', null, '加载原图…')),
      state === 'error' && createElement('div', { className: 'mm-lightbox-error' }, '原图加载失败'),
      state === 'done' && dataUrl && createElement('img', { className: 'mm-lightbox-img', src: dataUrl, alt: item.label || '' }),
      createElement('div', { className: 'mm-lightbox-bar' },
        createElement('div', { className: 'mm-lightbox-info' },
          createElement('span', { className: 'mm-lightbox-label' }, item.label || '未命名'),
          createElement('span', { className: 'mm-lightbox-meta' },
            [item.width && item.height ? `${item.width}×${item.height}` : '', item.animated ? '动图' : ''].filter(Boolean).join(' · ')),
        ),
        createElement('div', { className: 'mm-lightbox-actions' },
          onNav && createElement('button', { type: 'button', className: 'mm-lightbox-nav', onClick: () => onNav(-1), title: '上一张 (←)' }, '‹'),
          onNav && createElement('button', { type: 'button', className: 'mm-lightbox-nav', onClick: () => onNav(1), title: '下一张 (→)' }, '›'),
          createElement('button', {
            type: 'button', className: `mm-btn${isFavorite ? ' is-on' : ''}`, onClick: handleFavorite,
          }, isFavorite ? '★ 已收藏' : '☆ 收藏'),
          createElement('button', {
            type: 'button', className: 'mm-btn mm-btn-primary', onClick: handleCopy, disabled: state !== 'done' || copyState === 'busy',
          }, copyState === 'busy' ? '复制中…' : copyState === 'done' ? '已复制 ✓' : copyState === 'fail' ? '复制失败' : '复制'),
        ),
      ),
    ),
  )
}
