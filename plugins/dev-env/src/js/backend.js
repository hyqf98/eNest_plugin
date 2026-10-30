/**
 * backend.call 包装 + backend.event（task 进度）订阅 + 预览夹具演示数据。
 * 真实环境走 enest.backend.call；window.__preview 存在（scripts/preview-fixture.mjs）
 * 时全部 RPC 返回写死的演示数据，供市场截图与主题预览。
 */
const api = () => window.enest || window.zapi

export function backendReady() {
  return Boolean(api()?.backend?.call)
}

export function isPreviewFixture() {
  return typeof window !== 'undefined' && window.__preview !== undefined
}

async function call(method, args = []) {
  const host = api()
  if (!host?.backend?.call) throw new Error('后端接口不可用，请更新 eNest 壳子后重试')
  return host.backend.call(method, args)
}

export function onBackendEvent(handler) {
  const host = api()
  host?.on?.('backend.event', handler)
  return () => host?.off?.('backend.event', handler)
}

/* —— 演示数据（截图/预览夹具专用） —— */

const DEMO_DISKS = {
  npmCache: 1_530_000_000,
  npmGlobal: 96_000_000,
  nvm: 4_600_000_000,
  pipCache: 812_000_000,
  pyenv: 2_100_000_000,
  uvData: 640_000_000,
  uvCache: 1_240_000_000,
  m2: 6_800_000_000,
  gradle: 3_900_000_000,
  gradleCaches: 2_800_000_000,
  gradleDists: 720_000_000,
  gopath: 2_300_000_000,
  gomodcache: 1_700_000_000,
  gocache: 980_000_000,
  cargo: 1_050_000_000,
  registry: 780_000_000,
  rustup: 1_620_000_000,
  brewCellar: 5_400_000_000,
  brewCache: 2_150_000_000
}

const demoSnapshot = {
  platform: 'darwin',
  families: [
    { family: 'node', label: 'Node.js', installed: true, instances: [
      { id: 'node:system', family: 'node', label: 'Node (PATH)', version: 'v22.22.1', binPath: '/opt/homebrew/bin/node', note: 'npm: /opt/homebrew/bin/npm' },
      { id: 'node:nvm:v20.14.0', family: 'node', label: 'nvm · v20.14.0', version: 'v20.14.0', rootPath: '/Users/demo/.nvm/versions/node/v20.14.0', note: 'nvm 安装' }
    ] },
    { family: 'python', label: 'Python', installed: true, instances: [
      { id: 'python:system', family: 'python', label: 'Python (PATH · python3)', version: 'Python 3.13.11', binPath: '/Users/demo/.local/bin/python3.13' }
    ] },
    { family: 'uv', label: 'uv', installed: true, instances: [
      { id: 'uv:system', family: 'uv', label: 'uv (PATH)', version: 'uv 0.9.7', binPath: '/Users/demo/.local/bin/uv' }
    ] },
    { family: 'conda', label: 'Conda', installed: false, instances: [] },
    { family: 'java', label: 'Java', installed: true, instances: [
      { id: 'java:system', family: 'java', label: 'JDK (PATH)', version: 'openjdk "17.0.17" 2025-10-21', binPath: '/Users/demo/.sdkman/candidates/java/current/bin/java' }
    ] },
    { family: 'maven', label: 'Maven', installed: true, instances: [
      { id: 'maven:system', family: 'maven', label: 'Maven (PATH)', version: '3.9.11', binPath: '/opt/homebrew/bin/mvn', note: 'Maven home: /opt/homebrew/Cellar/maven' }
    ] },
    { family: 'gradle', label: 'Gradle', installed: true, instances: [
      { id: 'gradle:system', family: 'gradle', label: 'Gradle (PATH)', version: '9.5.1', binPath: '/opt/homebrew/bin/gradle' }
    ] },
    { family: 'go', label: 'Go', installed: true, instances: [
      { id: 'go:system', family: 'go', label: 'Go (PATH)', version: 'go version go1.25.3 darwin/arm64', binPath: '/opt/homebrew/bin/go' }
    ] },
    { family: 'rust', label: 'Rust', installed: true, instances: [
      { id: 'rust:cargo', family: 'rust', label: 'Rust (cargo)', version: 'cargo 1.95.0', binPath: '/Users/demo/.cargo/bin/cargo' },
      { id: 'rust:toolchain:stable-aarch64-apple-darwin', family: 'rust', label: 'toolchain · stable', version: 'stable-aarch64-apple-darwin', rootPath: '/Users/demo/.rustup/toolchains/stable-aarch64-apple-darwin', note: '默认 toolchain' },
      { id: 'rust:toolchain:1.82.0-aarch64-apple-darwin', family: 'rust', label: 'toolchain · 1.82.0', version: '1.82.0-aarch64-apple-darwin', rootPath: '/Users/demo/.rustup/toolchains/1.82.0-aarch64-apple-darwin' }
    ] }
  ],
  packageManagers: [
    { id: 'brew', label: 'Homebrew', available: true, prefix: '/opt/homebrew' },
    { id: 'winget', label: 'winget', available: false },
    { id: 'scoop', label: 'Scoop', available: false },
    { id: 'choco', label: 'Chocolatey', available: false }
  ]
}

const demoDetails = {
  'node:system': {
    instance: demoSnapshot.families[0].instances[0],
    diskUsage: [
      { label: 'npm 缓存', path: '/Users/demo/.npm', bytes: DEMO_DISKS.npmCache },
      { label: '全局包', path: '/opt/homebrew/lib/node_modules', bytes: DEMO_DISKS.npmGlobal },
      { label: '.nvm', path: '/Users/demo/.nvm', bytes: DEMO_DISKS.nvm }
    ],
    keyVars: [{ name: 'node 路径', value: '/opt/homebrew/bin/node' }],
    extra: ['npm: /opt/homebrew/bin/npm']
  },
  'python:system': { instance: demoSnapshot.families[1].instances[0], diskUsage: [{ label: 'pip 缓存', path: '/Users/demo/Library/Caches/pip', bytes: DEMO_DISKS.pipCache }, { label: 'pyenv versions', path: '/Users/demo/.pyenv/versions', bytes: DEMO_DISKS.pyenv }], keyVars: [{ name: '解释器', value: '/Users/demo/.local/bin/python3.13' }], extra: ['pip: /Users/demo/.local/bin/pip3', 'pyenv: 已安装'] },
  'uv:system': { instance: demoSnapshot.families[2].instances[0], diskUsage: [{ label: 'UV 数据', path: '/Users/demo/.local/share/uv', bytes: DEMO_DISKS.uvData }, { label: 'UV 缓存', path: '/Users/demo/Library/Caches/uv', bytes: DEMO_DISKS.uvCache }], keyVars: [{ name: 'uv 路径', value: '/Users/demo/.local/bin/uv' }] },
  'java:system': { instance: demoSnapshot.families[4].instances[0], diskUsage: [{ label: 'JDK 目录', path: '/Users/demo/.sdkman/candidates/java/17.0.17-ms', bytes: 320_000_000 }], keyVars: [{ name: 'JAVA_HOME', value: '/Users/demo/.sdkman/candidates/java/17.0.17-ms' }], extra: ['修改 JAVA_HOME 请使用环境变量类插件（本插件只读展示）'] },
  'maven:system': { instance: demoSnapshot.families[5].instances[0], diskUsage: [{ label: '本地仓库', path: '/Users/demo/.m2/repository', bytes: DEMO_DISKS.m2 }], keyVars: [{ name: 'settings.xml', value: '/Users/demo/.m2/settings.xml' }, { name: 'localRepository', value: '(默认 ~/.m2/repository)' }], extra: ['Java home: /Users/demo/.sdkman/candidates/java/17.0.17-ms', '清理历史测试失败缓存的 *.lastUpdated 文件可用「清理」页'] },
  'gradle:system': { instance: demoSnapshot.families[6].instances[0], diskUsage: [{ label: '~/.gradle 总占用', path: '/Users/demo/.gradle', bytes: DEMO_DISKS.gradle }, { label: 'caches', path: '/Users/demo/.gradle/caches', bytes: DEMO_DISKS.gradleCaches }, { label: 'wrapper', path: '/Users/demo/.gradle/wrapper', bytes: DEMO_DISKS.gradleDists }], keyVars: [{ name: 'GRADLE_USER_HOME', value: '(未设置，默认 ~/.gradle)' }] },
  'go:system': { instance: demoSnapshot.families[7].instances[0], diskUsage: [{ label: 'GOPATH', path: '/Users/demo/go', bytes: DEMO_DISKS.gopath }, { label: '模块缓存 GOMODCACHE', path: '/Users/demo/go/pkg/mod', bytes: DEMO_DISKS.gomodcache }, { label: '构建缓存 GOCACHE', path: '/Users/demo/Library/Caches/go-build', bytes: DEMO_DISKS.gocache }], keyVars: [{ name: 'GOPATH', value: '/Users/demo/go' }, { name: 'GOROOT', value: '/opt/homebrew/opt/go/libexec' }] },
  'rust:cargo': { instance: demoSnapshot.families[8].instances[0], diskUsage: [{ label: 'cargo home', path: '/Users/demo/.cargo', bytes: DEMO_DISKS.cargo }, { label: 'registry 缓存', path: '/Users/demo/.cargo/registry', bytes: DEMO_DISKS.registry }, { label: 'rustup home', path: '/Users/demo/.rustup', bytes: DEMO_DISKS.rustup }], keyVars: [{ name: 'CARGO_HOME', value: '(默认 /Users/demo/.cargo)' }, { name: 'RUSTUP_HOME', value: '(默认 /Users/demo/.rustup)' }] }
}

const demoDeps = {
  node: [
    { name: 'corepack', version: '0.32.0' }, { name: 'npm', version: '10.9.4' }, { name: 'pnpm', version: '10.14.0' },
    { name: 'pyright', version: '1.1.403' }, { name: 'typescript', version: '5.9.3' }, { name: 'uv', version: '0.9.7' },
    { name: 'yarn', version: '1.22.22' }
  ],
  python: [
    { name: 'pip', version: '25.2' }, { name: 'setuptools', version: '80.9.0' }, { name: 'wheel', version: '0.45.1' },
    { name: 'httpie', version: '3.2.4' }, { name: 'rich', version: '14.1.0' }, { name: 'uvicorn', version: '0.35.0' }
  ],
  uv: [
    { name: 'ruff', version: '0.14.5' }, { name: 'basedpyright', version: '1.29.5' }, { name: 'httpie', version: '3.2.4' },
    { name: 'sqlean.py', version: '3.49.0' }, { name: 'datasette', version: '0.66' }
  ],
  go: [
    { name: 'gopls', size: 38_400_000 }, { name: 'dlv', size: 24_100_000 }, { name: 'staticcheck', size: 29_800_000 },
    { name: 'gofumpt', size: 7_300_000 }, { name: 'goimports', size: 6_800_000 }
  ],
  rust: [
    { name: 'cargo-edit', version: '0.13.1' }, { name: 'cargo-outdated', version: '0.16.0' }, { name: 'ripgrep', version: '14.1.1' },
    { name: 'fd-find', version: '10.2.0' }, { name: 'bat', version: '0.25.0' }, { name: 'exa', version: '0.10.1' }
  ]
}

const demoCleanActions = {
  node: [{ id: 'npm-cache-verify', label: '校验并整理 npm 缓存', description: '运行 npm cache verify，清理缓存目录中的悬空数据（/Users/demo/.npm）', risk: 'safe' }],
  python: [{ id: 'pip-cache-purge', label: '清空 pip 缓存', description: '运行 python -m pip cache purge（缓存目录 /Users/demo/Library/Caches/pip）', risk: 'safe' }],
  uv: [{ id: 'uv-cache-clean', label: '清空 uv 缓存', description: '运行 uv cache clean（缓存目录 /Users/demo/Library/Caches/uv，含下载的 wheel 与编译缓存）', risk: 'safe' }],
  maven: [{ id: 'maven-lastupdated', label: '清理依赖下载失败缓存', description: '删除 ~/.m2/repository 下 *.lastUpdated 与 *m2e-lastUpdated.properties（拉取失败残留，可安全重建）', risk: 'safe' }],
  gradle: [{ id: 'gradle-modules2', label: '清理依赖缓存 modules-2', description: '删除 ~/.gradle/caches/modules-2（依赖缓存，下次构建自动重新下载）', risk: 'safe' }, { id: 'gradle-old-dists', label: '清理旧版本 Gradle 发行版', description: '删除 ~/.gradle/wrapper/dists 下非最新版本的 wrapper 发行版（保留每个大版本目录中最新的一个）', risk: 'cautious' }],
  go: [{ id: 'go-clean-modcache', label: '清理 Go 模块缓存', description: '运行 go clean -modcache（/Users/demo/go/pkg/mod）。注意：模块缓存含只读文件，命令会先 chmod 再删除', risk: 'cautious' }, { id: 'go-clean-cache', label: '清理 Go 构建缓存', description: '运行 go clean -cache（/Users/demo/Library/Caches/go-build，纯构建产物，可安全重建）', risk: 'safe' }],
  rust: [{ id: 'rust-registry', label: '清理 cargo registry 缓存', description: '删除 ~/.cargo/registry（下载的 crate 源码与二进制缓存，下次构建重新下载）', risk: 'safe' }, { id: 'rustup-old-toolchains', label: '卸载旧 rustup toolchain', description: '卸载除默认 toolchain 外的所有旧工具链（rustup toolchain uninstall）', risk: 'cautious' }],
  brew: [{ id: 'brew-cleanup', label: '清理 Homebrew 旧版本与缓存', description: '运行 brew cleanup --prune=all（删除旧版本包与下载缓存）', risk: 'safe' }, { id: 'brew-autoremove', label: '移除无用依赖', description: '运行 brew autoremove（清理不再被任何包依赖的孤立公式）', risk: 'cautious' }]
}

const demoConfigs = {
  node: [{ path: '/Users/demo/.npmrc', exists: true, bytes: 96, preview: 'registry=https://registry.npmjs.org/\ncache=/Volumes/Data/.npm-cache\nfund=false\naudit=false\n' }],
  python: [{ path: '/Users/demo/.config/pip/pip.conf', exists: true, bytes: 58, preview: '[global]\nindex-url = https://pypi.org/simple\n' }],
  maven: [{ path: '/Users/demo/.m2/settings.xml', exists: true, bytes: 1842, preview: '<?xml version="1.0" encoding="UTF-8"?>\n<settings>\n  <localRepository>/Users/demo/.m2/repository</localRepository>\n  <mirrors>\n    <mirror>\n      <id>nexus</id>\n      <url>https://nexus.example.com/repository/maven-public/</url>\n      <mirrorOf>*</mirrorOf>\n    </mirror>\n  </mirrors>\n</settings>\n' }],
  gradle: [{ path: '/Users/demo/.gradle/gradle.properties', exists: true, bytes: 210, preview: 'org.gradle.jvmargs=-Xmx3g -Dfile.encoding=UTF-8\norg.gradle.parallel=true\norg.gradle.caching=true\n' }],
  go: [{ path: '/Users/demo/Library/Application Support/go/env', exists: true, bytes: 76, preview: 'GOPROXY=https://goproxy.cn,direct\nGOSUMDB=sum.golang.org\n' }],
  rust: [{ path: '/Users/demo/.cargo/config.toml', exists: true, bytes: 148, preview: '[source.crates-io]\nreplace-with = "ustc"\n\n[source.ustc]\nregistry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"\n' }]
}

const demoPmList = {
  brew: [
    { name: 'bat', version: '0.25.0', type: 'formula' }, { name: 'cmake', version: '4.2.1', type: 'formula' },
    { name: 'docker', version: '3.0.4', type: 'cask' }, { name: 'ffmpeg', version: '7.1.1', type: 'formula' },
    { name: 'fzf', version: '0.64.0', type: 'formula' }, { name: 'gh', version: '2.79.0', type: 'formula', outdated: true },
    { name: 'git', version: '2.39.5', type: 'formula' }, { name: 'go', version: '1.25.3', type: 'formula' },
    { name: 'gradle', version: '9.5.1', type: 'formula' }, { name: 'icu4c@76', version: '76.1', type: 'formula' },
    { name: 'intellij-idea', version: '2026.2.4', type: 'cask', outdated: true },
    { name: 'jq', version: '1.8.1', type: 'formula' }, { name: 'node', version: '22.22.1', type: 'formula' },
    { name: 'openjdk@17', version: '17.0.17', type: 'formula' }, { name: 'ripgrep', version: '14.1.1', type: 'formula' },
    { name: 'visual-studio-code', version: '1.104.2', type: 'cask' }, { name: 'wget', version: '1.25.0', type: 'formula' }
  ]
}

function demoCall(method, args) {
  const arg0 = args?.[0] ?? {}
  switch (method) {
    case 'snapshot': return demoSnapshot
    case 'detail': return demoDetails[arg0.id] ?? { instance: { id: arg0.id, family: arg0.family, label: arg0.id } }
    case 'deps': return { deps: demoDeps[arg0.family] ?? [] }
    case 'removeDep': return { ok: true, note: `已卸载 ${arg0.name}` }
    case 'cleanActions': return { actions: demoCleanActions[arg0.family] ?? demoCleanActions[arg0.pm] ?? [] }
    case 'cleanDryRun': return { lines: [`将执行：${arg0.actionId}`, '删除 412 个文件 / 36 个目录', '预计释放 1.42 GB'] }
    case 'cleanRun': return { ok: true, note: '清理完成', freedBytes: 1_520_000_000 }
    case 'configs': return { files: demoConfigs[arg0.family] ?? [] }
    case 'configRead': return { content: (demoConfigs.node[0]).preview }
    case 'migratePlan': return {
      steps: [`创建目标目录 ${arg0.target ?? '/Volumes/Data/npm-cache'}`, '更新 .npmrc 的 cache= 配置', '复制缓存数据（1459.5 MB）并校验', '删除旧缓存目录'],
      configChanges: [{ file: '/Users/demo/.npmrc', from: '(未设置，npm 默认)', to: `cache=${arg0.target ?? '/Volumes/Data/npm-cache'}` }],
      dataBytes: DEMO_DISKS.npmCache
    }
    case 'migrateRun': return { ok: true, note: '迁移完成，配置已更新' }
    case 'pm.list': return { items: demoPmList[arg0.pm] ?? [] }
    case 'pm.search': return {
      items: [
        { name: 'ripgrep', type: 'formula' }, { name: 'ripgrep-all', type: 'formula' }, { name: 'ripes', type: 'cask' },
        { name: 'rider', type: 'cask' }, { name: 'rive', type: 'cask' }
      ]
    }
    case 'pm.install': case 'pm.uninstall': case 'pm.upgrade': case 'pm.updateSource': case 'pm.cleanRun':
      return { ok: true, note: '演示环境：操作已模拟' }
    case 'pm.outdated': return { items: demoPmList.brew.filter(item => item.outdated) }
    case 'pm.detail': return { instance: { id: 'pm:brew', family: 'pm', label: 'Homebrew' }, diskUsage: [{ label: 'Cellar（已安装包）', path: '/opt/homebrew/Cellar', bytes: DEMO_DISKS.brewCellar }, { label: '下载缓存', path: '/Users/demo/Library/Caches/Homebrew', bytes: DEMO_DISKS.brewCache }, { label: 'prefix', path: '/opt/homebrew', bytes: 410_000_000 }], extra: ['brew: /opt/homebrew/bin/brew'] }
    case 'task.run': return { taskId: `demo-${Math.random().toString(36).slice(2, 8)}` }
    case 'task.cancel': return { ok: true }
    case 'task.status': return []
    default: return {}
  }
}

/** demo 模式下模拟 task 事件流（task.output 两行 + task.end）。 */
function simulateDemoTask(taskId, handler) {
  const lines = ['==> Downloading https://ghcr.io/v2/homebrew/core/ripgrep/manifests/14.1.1', '==> Pouring ripgrep--14.1.1.arm64_sonoma.bottle.tar.gz', '🍺  /opt/homebrew/Cellar/ripgrep/14.1.1: 35 files, 8.4MB']
  lines.forEach((line, index) => setTimeout(() => handler({ event: 'task', data: { type: 'task.output', taskId, chunk: line } }), 400 * (index + 1)))
  setTimeout(() => handler({ event: 'task', data: { type: 'task.end', taskId, ok: true, note: '演示任务完成' } }), 400 * (lines.length + 1))
}

export const backend = {
  async snapshot(custom) { return isPreviewFixture() ? demoSnapshot : call('snapshot', [custom ? { custom } : {}]) },
  async detail(family, id, custom) { return isPreviewFixture() ? demoCall('detail', [{ family, id }]) : call('detail', [{ family, id, custom }]) },
  async deps(family, id) { return isPreviewFixture() ? demoCall('deps', [{ family, id }]) : call('deps', [{ family, id }]) },
  async removeDep(family, id, name) { return isPreviewFixture() ? demoCall('removeDep', [{ family, id, name }]) : call('removeDep', [{ family, id, name }]) },
  async cleanActions(family, id) { return isPreviewFixture() ? demoCall('cleanActions', [{ family, id }]) : call('cleanActions', [{ family, id }]) },
  async cleanDryRun(family, id, actionId) { return isPreviewFixture() ? demoCall('cleanDryRun', [{ family, id, actionId }]) : call('cleanDryRun', [{ family, id, actionId }]) },
  async cleanRun(family, id, actionId) { return isPreviewFixture() ? demoCall('cleanRun', [{ family, id, actionId }]) : call('cleanRun', [{ family, id, actionId }]) },
  async configs(family, id) { return isPreviewFixture() ? demoCall('configs', [{ family, id }]) : call('configs', [{ family, id }]) },
  async configRead(pathName) { return isPreviewFixture() ? demoCall('configRead', [pathName]) : call('configRead', [pathName]) },
  async migratePlan(family, id, target) { return isPreviewFixture() ? demoCall('migratePlan', [{ family, id, target }]) : call('migratePlan', [{ family, id, target }]) },
  async migrateRun(family, id, target, moveData) { return isPreviewFixture() ? demoCall('migrateRun', [{ family, id, target, moveData }]) : call('migrateRun', [{ family, id, target, moveData }]) },
  async pmList(pm) { return isPreviewFixture() ? demoCall('pm.list', [{ pm }]) : call('pm.list', [{ pm }]) },
  async pmSearch(pm, q) { return isPreviewFixture() ? demoCall('pm.search', [{ pm, q }]) : call('pm.search', [{ pm, q }]) },
  async pmInstall(pm, name, opts) { return isPreviewFixture() ? demoCall('pm.install', [{ pm, name, opts }]) : call('pm.install', [{ pm, name, opts }]) },
  async pmUninstall(pm, name, opts) { return isPreviewFixture() ? demoCall('pm.uninstall', [{ pm, name, opts }]) : call('pm.uninstall', [{ pm, name, opts }]) },
  async pmUpgrade(pm, name) { return isPreviewFixture() ? demoCall('pm.upgrade', [{ pm, name }]) : call('pm.upgrade', [{ pm, name }]) },
  async pmOutdated(pm) { return isPreviewFixture() ? demoCall('pm.outdated', [{ pm }]) : call('pm.outdated', [{ pm }]) },
  async pmUpdateSource(pm) { return isPreviewFixture() ? demoCall('pm.updateSource', [{ pm }]) : call('pm.updateSource', [{ pm }]) },
  async pmDetail(pm) { return isPreviewFixture() ? demoCall('pm.detail', [{ pm }]) : call('pm.detail', [{ pm }]) },
  async pmCleanActions(pm) { return isPreviewFixture() ? demoCall('cleanActions', [{ pm }]) : call('pm.cleanActions', [{ pm }]) },
  async pmCleanRun(pm, actionId) { return isPreviewFixture() ? demoCall('pm.cleanRun', [{ pm, actionId }]) : call('pm.cleanRun', [{ pm, actionId }]) },
  async taskRun(spec, onTaskEvent) {
    if (isPreviewFixture()) {
      const { taskId } = demoCall('task.run', [spec])
      if (onTaskEvent) simulateDemoTask(taskId, onTaskEvent)
      return { taskId }
    }
    return call('task.run', [spec])
  },
  async taskCancel(taskId) { return isPreviewFixture() ? demoCall('task.cancel', [taskId]) : call('task.cancel', [taskId]) }
}
