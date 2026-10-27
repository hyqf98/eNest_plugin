import '@xyflow/react/dist/style.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import './css/main.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'ai-canvas', family: 'flow', scope: '#root',
  regions: { toolbar: '.ac-toolbar', main: '.ac-stage', auxiliary: '.ac-rail', status: '.ac-status' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'
import './ui/pk-ui.css'

createRoot(document.getElementById('root')).render(createElement(App))
