import { sshIndexedView } from '@ssh/js/launch-index.js'

void sshIndexedView.start(() => import('./view.js')).catch(() => {})
