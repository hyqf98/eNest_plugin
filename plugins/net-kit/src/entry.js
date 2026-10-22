import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'net-kit', family: 'workbench', scope: '#root',
  regions: { navigation: '.nk-col-tree', toolbar: '.nk-top', main: '.nk-split', auxiliary: '.nk-viewer', status: '.nk-foot' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
