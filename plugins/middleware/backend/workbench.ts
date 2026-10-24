import { MW_MUTATING_ACTIONS } from '@backend/contracts/mw-workbench'

export type MiddlewarePermission = 'mw.connect' | 'mw.query' | 'mw.admin'

/** Domain policy belongs to this plugin, not the generic host dispatcher. */
export function mwWorkbenchPermission(action: string): MiddlewarePermission {
  switch (action) {
    case 'kinds.list': case 'test':
    case 'session.open': case 'session.close': case 'session.list': return 'mw.connect'
    case 'overview': case 'topics.list': case 'topic.describe':
    case 'exchanges.list': case 'bindings.list':
    case 'groups.list': case 'group.describe': case 'clients.list':
    case 'messages.query': case 'messages.get':
    case 'tail.start': case 'tail.stop':
    case 'configs.describe': case 'trace.message': case 'retained.list': return 'mw.query'
    default:
      if (MW_MUTATING_ACTIONS.includes(action)) return 'mw.admin'
      throw new Error(`Unknown middleware workbench action: ${String(action)}`)
  }
}
