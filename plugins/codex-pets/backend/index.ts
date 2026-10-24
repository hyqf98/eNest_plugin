import { startAgentBackend } from '@enest/agent-config-backend/worker'

startAgentBackend({ pluginId: 'com.github.eNest.codex-pets', mode: 'pets' })
