/**
 * demo —— 截图 fixture / 无后端预览的隔离演示数据（无真实文件、无注册表、无 launchctl）。
 * window.__preview 存在（截图环境）或 backend.call 不可用时启用；
 * 写操作一律返回 { ok: true }，仅保证界面完整可见。
 */

const NOW = 1791856800000
const HOME = '/Users/demo'

const demoVars = [
  { name: 'ANDROID_HOME', value: `${HOME}/Library/Android/sdk`, scope: 'persistent', origin: `${HOME}/.zshenv`, line: 12, managed: true },
  { name: 'ANT_HOME', value: '/opt/homebrew/opt/ant', scope: 'persistent', origin: `${HOME}/.zshenv`, line: 13, managed: true },
  { name: 'EDITOR', value: 'vim', scope: 'persistent', origin: `${HOME}/.zshrc`, line: 24, exported: true },
  { name: 'GRADLE_HOME', value: `${HOME}/.gradle`, scope: 'persistent', origin: `${HOME}/.zshenv`, line: 14, managed: true },
  { name: 'GROOVY_HOME', value: '/opt/homebrew/opt/groovy/libexec', scope: 'persistent', origin: `${HOME}/.zprofile`, line: 6 },
  { name: 'JAVA_HOME', value: '/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home', scope: 'persistent', origin: `${HOME}/.zshenv`, line: 11, managed: true },
  { name: 'LANG', value: 'zh_CN.UTF-8', scope: 'persistent', origin: `${HOME}/.zshrc`, line: 25 },
  { name: 'MAVEN_OPTS', value: '-Xmx2g -Dfile.encoding=UTF-8', scope: 'persistent', origin: `${HOME}/.zshrc`, line: 31 },
  { name: 'NODE_ENV', value: 'development', scope: 'persistent', origin: `${HOME}/.zshrc`, line: 40, managed: true },
  { name: 'PNPM_HOME', value: `${HOME}/.local/share/pnpm`, scope: 'persistent', origin: `${HOME}/.zshrc`, line: 41, managed: true },
  { name: 'PROJECT_HOME', value: '$HOME/Work', scope: 'persistent', origin: `${HOME}/.zshrc`, line: 55, hasReference: true },
  { name: 'PYTHONPATH', value: '/opt/homebrew/lib/python3.13/site-packages', scope: 'persistent', origin: `${HOME}/.zprofile`, line: 7 },
  { name: 'WORKSPACE', value: '$PROJECT_HOME/eNest', scope: 'persistent', origin: `${HOME}/.zshrc`, line: 56, hasReference: true },
  { name: 'PATH', value: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.local/bin`, scope: 'process' },
  { name: 'SHELL', value: '/bin/zsh', scope: 'process' },
  { name: 'TERM', value: 'xterm-256color', scope: 'process' },
  { name: 'TMPDIR', value: '/var/folders/t3/demo/T/', scope: 'process' },
  { name: 'USER', value: 'demo', scope: 'process' },
  { name: 'HOME', value: HOME, scope: 'process' },
  { name: 'LOGNAME', value: 'demo', scope: 'process' }
]

const demoScopes = [
  { id: 'process', label: '当前进程', count: 7 },
  { id: 'persistent', label: '持久化（shell 配置）', count: 13 },
  { id: 'path', label: 'PATH 来源', count: 0 }
]

const demoPathParts = {
  entries: ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', `${HOME}/.local/bin`, '/opt/homebrew/bin'],
  sources: [
    { file: '/etc/paths', entries: ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'] },
    { file: '/etc/paths.d/10-homebrew', entries: ['/opt/homebrew/bin'] },
    { file: '/etc/paths.d/40-local', entries: [`${HOME}/.local/bin`] }
  ]
}

const demoBackups = [
  { file: `${HOME}/.zshenv.enest-backup-20261028-142301`, size: 842, createdAt: NOW - 3600_000 * 26 },
  { file: `${HOME}/.zshrc.enest-backup-20261027-093015`, size: 3126, createdAt: NOW - 3600_000 * 71 },
  { file: `${HOME}/.zprofile.enest-backup-20261021-183344`, size: 508, createdAt: NOW - 3600_000 * 162 }
]

export const demo = {
  snapshot: () => ({ platform: 'darwin', scopes: demoScopes, vars: demoVars.map(item => ({ ...item })) }),
  setVar: () => ({ ok: true, elevated: false, note: '演示模式：未写入真实文件' }),
  deleteVar: () => ({ ok: true, elevated: false, note: '演示模式：未修改真实文件' }),
  getSettings: () => ({ macTarget: 'zshenv', launchctlSync: true }),
  setSettings: partial => ({ macTarget: 'zshenv', launchctlSync: true, ...partial }),
  listBackups: () => demoBackups.map(item => ({ ...item })),
  restoreBackup: () => ({ ok: true }),
  pathParts: () => demoPathParts,
  openManagedFolder: () => true
}
