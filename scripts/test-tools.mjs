import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['--test', 'scripts/tests/dual-mode-tools.spec.mjs'], { stdio: 'inherit', env: { ...process.env, DUAL_MODE_UI: '1' } })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
