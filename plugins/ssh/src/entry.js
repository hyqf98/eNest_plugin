/* CSS 级联顺序是像素级一致的命门：原版 index.html 中 main.css / workbench.css
   以 <link> 先于 plugin-kit CSS 加载，React 化后必须在 entry.js 最先 import 复刻该顺序 */
import '@ssh/css/main.css'
import '@ssh/css/workbench.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit/workbench.css'
import '@enest/plugin-kit'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './jsx/App.jsx'

createRoot(document.getElementById('root')).render(createElement(App))
import './ui/pk-ui.css'
