import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { copyImage, localFiles } from '../js/api.mjs'
import { listFavorites, removeFavorite, clearFavorites, importLocal, favoriteDataUrlCached } from '../js/favorites.mjs'
import { SkeletonMasonry, LoadingMore, ErrorState, EmptyState, FilterChips } from './widgets.jsx'
import { Lightbox } from './Lightbox.jsx'

/**
 * FavoritesPage — 收藏夹：网格浏览（离线可用）、点击复制、
 * 导入本地图片（文件选择 + 拖拽）、多选删除、清空。
 */
export function FavoritesPage({ showToast, onFavoriteChange }) {
  const [entries, setEntries] = useState(null)
  const [images, setImages] = useState({}) // id -> dataUrl
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [zoom, setZoom] = useState(null)
  const [dragOver, setDragOver] = useState(false)
  const [search, setSearch] = useState('')
  const visibleCount = useRef(60)

  const reload = useCallback(async () => {
    setEntries(null)
    setError('')
    visibleCount.current = 60
    try {
      const list = await listFavorites()
      setEntries(list)
      setImages({})
    } catch (err) {
      setError(err.message || String(err))
    }
  }, [])

  useEffect(() => { reload() }, [reload])

  // 渐进渲染收藏图（assets.get 有 IO 成本，分批取）
  useEffect(() => {
    if (!entries) return
    let alive = true
    const targets = entries.filter(entry => !images[entry.id]).slice(0, 12)
    if (!targets.length) return
    ;(async () => {
      for (const entry of targets) {
        if (!alive) return
        const dataUrl = await favoriteDataUrlCached(entry).catch(() => null)
        if (!alive) return
        if (dataUrl) setImages(prev => ({ ...prev, [entry.id]: dataUrl }))
      }
    })()
    return () => { alive = false }
  }, [entries, images])

  async function handleCopy(entry, dataUrl) {
    if (!dataUrl) { showToast('图片还在加载，稍后再试', 'fail'); return }
    try {
      const ok = await copyImage(dataUrl)
      if (!ok) throw new Error('写入剪贴板失败')
      showToast(entry.animated ? '已复制动图（粘贴保动画）' : '已复制')
    } catch (err) {
      showToast(`复制失败：${err.message || err}`, 'fail')
    }
  }

  async function handleRemove(ids) {
    try {
      for (const id of ids) {
        await removeFavorite(id)
        onFavoriteChange(id)
      }
      showToast(`已删除 ${ids.length} 项`)
      setSelected(new Set())
      setSelectMode(false)
      reload()
    } catch (err) {
      showToast(`删除失败：${err.message || err}`, 'fail')
    }
  }

  async function importFromHandles(handles) {
    let ok = 0
    for (const handle of handles) {
      try {
        const dataUrl = await localFiles().read({ handleId: handle.handleId, encoding: 'dataUrl' })
        await importLocal(dataUrl, handle.name || '')
        ok += 1
      } catch { /* 单个失败跳过 */ }
    }
    showToast(ok ? `已导入 ${ok} 张图片` : '导入失败，请确认选择的是图片文件', ok ? 'ok' : 'fail')
    reload()
  }

  async function handlePick() {
    try {
      const handles = await localFiles().pick({
        multiple: true,
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      })
      if (handles?.length) importFromHandles(handles)
    } catch { /* 用户取消 */ }
  }

  async function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'))
    if (!files.length) return
    try {
      const handles = await localFiles().fromDrop(files)
      if (handles?.length) importFromHandles(handles)
    } catch {
      showToast('拖拽导入失败', 'fail')
    }
  }

  const filtered = entries ? entries.filter(entry => !search.trim() || (entry.label || '').toLowerCase().includes(search.trim().toLowerCase())) : null
  const visible = filtered ? filtered.slice(0, visibleCount.current) : []

  return createElement('div', { className: 'mm-page' },
    createElement('div', { className: 'mm-top' },
      createElement('div', { className: 'mm-fav-tools' },
        createElement('button', { type: 'button', className: 'mm-btn', onClick: handlePick }, '导入图片'),
        selectMode
          ? createElement('button', { type: 'button', className: 'mm-btn', onClick: () => { setSelectMode(false); setSelected(new Set()) } }, '取消')
          : createElement('button', { type: 'button', className: 'mm-btn', onClick: () => setSelectMode(true) }, '管理'),
        selectMode && selected.size > 0 && createElement('button', {
          type: 'button', className: 'mm-btn mm-btn-danger', onClick: () => handleRemove([...selected]),
        }, `删除 ${selected.size} 项`),
        entries?.length > 0 && !selectMode && createElement('button', {
          type: 'button', className: 'mm-btn mm-btn-ghost',
          onClick: async () => { await clearFavorites(); onFavoriteChange; reload(); showToast('已清空收藏') },
        }, '清空'),
      ),
      createElement('input', {
        className: 'mm-search-input mm-fav-search', type: 'text', placeholder: '筛选收藏',
        value: search, onChange: e => setSearch(e.target.value),
      }),
    ),
    createElement('div', { className: 'mm-body', onDragOver: e => { e.preventDefault(); setDragOver(true) }, onDragLeave: () => setDragOver(false), onDrop: handleDrop },
      entries === null && !error && createElement(SkeletonMasonry, { count: 12 }),
      error && createElement(ErrorState, { message: error, onRetry: reload }),
      entries && entries.length === 0 && createElement(EmptyState, {
        text: '还没有收藏', hint: '在表情包页点击卡片复制，hover 点 ☆ 收藏；也可以直接拖入图片导入',
      }),
      entries && entries.length > 0 && filtered.length === 0 && createElement(EmptyState, { text: '没有匹配的收藏' }),
      filtered && filtered.length > 0 && createElement('div', { className: `mm-masonry${dragOver ? ' is-drag' : ''}` },
        visible.map((entry, index) => {
          const dataUrl = images[entry.id]
          const ratio = entry.width > 0 && entry.height > 0 ? entry.width / entry.height : 1
          const isSel = selected.has(entry.id)
          return createElement('div', {
            key: entry.id,
            className: `mm-card${selectMode && isSel ? ' is-selected' : ''}${selectMode ? ' is-select' : ''}`,
            style: { aspectRatio: String(ratio) },
            onClick: () => {
              if (selectMode) {
                setSelected(prev => { const next = new Set(prev); next.has(entry.id) ? next.delete(entry.id) : next.add(entry.id); return next })
              } else handleCopy(entry, dataUrl)
            },
            title: `${entry.label || ''} · 点击复制`,
          },
            createElement('div', { className: 'mm-card-media' },
              dataUrl
                ? createElement('img', { src: dataUrl, alt: entry.label || '', draggable: false })
                : createElement('div', { className: 'mm-card-ph' }, createElement('span', { className: 'mm-spinner' })),
              entry.animated && createElement('span', { className: 'mm-badge mm-badge-gif' }, 'GIF'),
              entry.source === 'local' && createElement('span', { className: 'mm-badge mm-badge-local' }, '本地'),
            ),
            createElement('div', { className: 'mm-card-actions' },
              createElement('button', {
                type: 'button', className: 'mm-act mm-act-danger', title: '删除',
                onClick: e => { e.stopPropagation(); handleRemove([entry.id]) },
              }, '🗑'),
              createElement('button', {
                type: 'button', className: 'mm-act', title: '放大',
                onClick: e => { e.stopPropagation(); setZoom({ entry, dataUrl, index }) },
              }, '⤢'),
            ),
            selectMode && createElement('span', { className: `mm-check${isSel ? ' is-on' : ''}` }, isSel ? '✓' : ''),
          )
        }),
      ),
      filtered && filtered.length > visibleCount.current && createElement('button', {
        type: 'button', className: 'mm-loadmore', onClick: () => { visibleCount.current += 60; setEntries(prev => [...prev]) },
      }, '加载更多'),
    ),
    zoom && createElement(Lightbox, {
      item: { ...zoom.entry, imageUrl: '' }, isFavorite: true, onFavoriteChange: () => {},
      onClose: () => setZoom(null), showToast, overrideDataUrl: zoom.dataUrl,
    }),
  )
}
