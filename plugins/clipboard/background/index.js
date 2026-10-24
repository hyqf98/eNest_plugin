import { createClipboardHistory } from './history.mjs'

const bridge = window.enestBackground
if (!bridge) throw new Error('eNest background runtime is required')
const history = createClipboardHistory(bridge.host)
bridge.register({ onEvent: history.onEvent, call: history.call, search: history.search })
window.addEventListener('pagehide', () => history.dispose(), { once: true })
