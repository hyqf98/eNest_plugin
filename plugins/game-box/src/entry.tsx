import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

window.PluginKit?.useAppearanceLayout({
  plugin: 'game-box',
  family: 'collection',
  scope: '#root',
  regions: { navigation: '.gh-nav', main: '.gh-view' },
})

const root = document.getElementById('root')
if (!root) throw new Error('game-box root element is missing')
createRoot(root).render(createElement(App))
