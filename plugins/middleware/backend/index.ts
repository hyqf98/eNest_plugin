import { parentPort } from '@backend/parentPort'
import { createMiddlewareBackend } from '@backend/worker'
import { getMwDriver, mwDriverDescriptors } from '@backend/drivers'

if (!parentPort) throw new Error('Middleware requires an eNest utility process')
const backend = createMiddlewareBackend({ port: parentPort, getDriver: getMwDriver, descriptors: mwDriverDescriptors,
  onShutdown: ok => process.exit(ok ? 0 : 1) })
process.once('SIGTERM', () => { void backend.shutdown() })
process.once('SIGINT', () => { void backend.shutdown() })
