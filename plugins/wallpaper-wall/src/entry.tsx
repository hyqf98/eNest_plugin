import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App'

window.PluginKit?.useAppearanceLayout({
  plugin: 'wallpaper-wall',
  family: 'collection',
  scope: '#root',
  regions: { navigation: '.wh-rail', main: '.wh-main' },
})

const root = document.getElementById('root')
if (!root) throw new Error('wallpaper-wall root element is missing')
createRoot(root).render(createElement(App))
