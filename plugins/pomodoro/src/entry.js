import './css/main.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'pomodoro', family: 'instrument', scope: '#root',
  regions: { navigation: '.segmented', toolbar: 'header', main: '.focus-panel', auxiliary: '.journal', status: '#hint' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'
import './ui/pk-ui.css'

createRoot(document.getElementById('root')).render(createElement(App))
