import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './js/ErrorBoundary'

window.PluginKit?.useAppearanceLayout({
  plugin: 'media-browser',
  family: 'collection',
  scope: '#root',
  regions: { navigation: '.mb-side', main: '.mb-main' },
})

const root = document.getElementById('root')
if (!root) throw new Error('media-browser root element is missing')
createRoot(root).render(createElement(ErrorBoundary, null, createElement(App)))
