import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

window.PluginKit?.useAppearanceLayout({
  plugin: 'game-house',
  family: 'collection',
  scope: '#root',
  regions: { toolbar: '.gh-toolbar-bar', main: '.gh-view' },
})

const root = document.getElementById('root')
if (!root) throw new Error('game-house root element is missing')
createRoot(root).render(createElement(App))
