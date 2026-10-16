import './css/dsh.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
