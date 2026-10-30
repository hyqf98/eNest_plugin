import { databaseIndexedView } from '@db/launch-index.js'

void databaseIndexedView.start(() => import('./view.js')).catch(() => {})
