import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { listFavorites } from '../js/favorites.mjs'
import { HomePage } from './HomePage.jsx'
import { FavoritesPage } from './FavoritesPage.jsx'

/**
 * App — 视图状态机：browse（浏览/搜索）| favorites（收藏夹）。
 * 收藏状态全局共享（跨页星标同步），复制反馈 toast 全局。
 */

export function App() {
  const [view, setView] = useState('browse')
  const [favIds, setFavIds] = useState(() => new Set())
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)

  useEffect(() => {
    let alive = true
    listFavorites().then(entries => {
      if (alive) setFavIds(new Set(entries.map(entry => entry.id)))
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  const showToast = useCallback((text, kind = 'ok') => {
    setToast({ text, kind, at: Date.now() })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 1800)
  }, [])

  const isFavorite = useCallback(id => favIds.has(id), [favIds])

  const onFavoriteChange = useCallback(id => {
    setFavIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const body = view === 'favorites'
    ? createElement(FavoritesPage, { showToast, onFavoriteChange })
    : createElement(HomePage, { showToast, isFavorite, onFavoriteChange, goFavorites: () => setView('favorites') })

  return createElement('div', { className: 'mm-app' },
    createElement('nav', { className: 'mm-nav' },
      createElement('div', { className: 'mm-nav-tabs' },
        navTab('browse', '表情包', view, setView),
        navTab('favorites', '收藏夹', view, setView),
      ),
    ),
    body,
    toast && createElement('div', { key: toast.at, className: `mm-toast mm-toast-${toast.kind}` }, toast.text),
  )
}

function navTab(name, label, view, setView) {
  return createElement('button', {
    key: name,
    type: 'button',
    className: `mm-tab${view === name ? ' is-active' : ''}`,
    onClick: () => setView(name),
  }, label)
}
