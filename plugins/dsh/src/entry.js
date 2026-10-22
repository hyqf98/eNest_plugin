import './css/dsh.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
window.PluginKit.useAppearanceLayout({
  plugin: 'dsh', family: 'workbench', scope: '#root',
  regions: { navigation: '.dsh-settings-navigation', toolbar: '.dsh-settings-header,.shellbar,.cockpit-head', main: '.dsh-settings-main,.activity,.guide,.web-frame', auxiliary: '.sessions', status: '.dsh-settings-header-status,.composer-hint' }
})
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
