import { startSshWorker } from '@enest/ssh-backend/runtime'
import { RdpBridgeService } from './rdpBridge'

startSshWorker(context => {
  const rdp = new RdpBridgeService(context)
  return {
    methods: {
      'rdp.open': (_owner, input) => rdp.open(input),
      'rdp.close': (_owner, id) => rdp.close(id)
    },
    dispose: () => { rdp.dispose(); return rdp.drain() }
  }
})
