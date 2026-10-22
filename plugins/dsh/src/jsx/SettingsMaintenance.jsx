import { useState } from 'react'
import { Button, Segmented } from '@dsh/ui/index.jsx'
import { IconArchive, IconRestart } from './icons.jsx'
import { EmptyState, Facts, InlineMessage, LoadingBlock, Panel, SectionHeading } from './SettingsPrimitives.jsx'
import { formatBytes, formatTime, listData, sourceLabel } from './SettingsController.jsx'

// Protect common credential shapes in process output without reading any config or environment.
function redactLog(line) {
  return String(line)
    .replace(/((?:[a-z_]*api[_-]?key|authorization|access[_-]?token|password|secret)[\s"']*[:=][\s"']*)([^\s,"'}]+)/gi, '$1[已隐藏]')
    .replace(/(bearer\s+)[\w.\-]+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/([?&](?:token|key|auth|password)=)[^\s&]+/gi, '$1[已隐藏]')
    .replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[已隐藏]@')
}

export function SettingsMaintenance({ state, controller }) {
  const { resources, pending, call, run, ask, requireLoad } = controller
  const [showDanger, setShowDanger] = useState(false)
  const [backupScope, setBackupScope] = useState('all')
  const backups = listData(resources.backups.data)
  const filteredBackups = backupScope === 'all' ? backups : backups.filter((entry) => entry.scope === backupScope)
  const home = state.runtime?.dshHome || state.status?.runtime?.dshHome
  const blocked = Boolean(pending)
  const createBackup = () => ask({
    title: '停止进程并创建全量备份？',
    description: '为保证快照一致，宿主会先停止 Web 与 SDK，正在进行的对话可能中断。备份包括凭据与会话，仅存本机。',
    label: '停止并备份', operation: '创建全量备份',
    task: async () => {
      await call('backup.create', { label: `手动备份 ${new Date().toLocaleString()}` })
      await controller.refreshHost()
      await requireLoad(controller.loadBackups())
    },
    success: '全量备份已保存到本机，进程保持停止。备份可能含有 API 凭据，请妥善保管。',
  })
  const restoreBackup = (entry) => ask({
    title: `恢复${entry.scope === 'profile' ? ' Profile' : '全量'}备份？`,
    description: entry.scope === 'profile'
      ? `将停止 Web 与 SDK，先备份 ${entry.target || '对应 Profile'} 的当前配置，再覆盖该 Profile。现有会话不会因 Profile 恢复而删除。`
      : '将停止 Web 与 SDK，先对当前 DSH_HOME 做全量备份，再用所选快照覆盖配置、凭据与会话。当前会话会被替换，请确认备份时间。',
    detail: `${entry.name || entry.backupId}\n${formatTime(entry.createdAt)}\n目标：${home || '未探测'}`,
    label: '备份当前并恢复', danger: true,
    task: async () => {
      await call('backup.restore', { backupId: entry.backupId })
      await controller.refreshHost({ detect: true, sessions: true, settings: true })
      await Promise.all([
        requireLoad(controller.loadBackups()), requireLoad(controller.loadProfiles()), requireLoad(controller.loadSettings()),
      ])
    },
    success: '备份已恢复，恢复前快照也已保留。Web 与 SDK 保持停止，请按需手动启动。',
  })
  const deleteBackup = (entry) => ask({
    title: '永久删除这份备份？',
    description: '只删除此本机快照，不影响当前 Profile 与会话。这份备份删除后无法恢复。',
    detail: `${entry.name || entry.backupId}\n${formatTime(entry.createdAt)} / ${formatBytes(entry.sizeBytes)}`,
    label: '删除备份', danger: true,
    task: async () => {
      await call('backup.delete', { backupId: entry.backupId })
      await requireLoad(controller.loadBackups())
    },
    success: '备份已删除，当前运行数据未更改。',
  })
  const reset = (scope) => ask({
    title: scope === 'config' ? '清空配置并保留会话？' : '重置整个 DSH_HOME？',
    description: scope === 'config'
      ? '宿主会停止 Web 与 SDK 并先创建全量备份。随后移除 Profiles、home 补丁、凭据、.env 与启动选择；保留 storages、sessions 与 logs。已有会话可能需要重新配置模型才能继续。'
      : '此操作会停止 Web 与 SDK，先创建全量备份，再清空当前 DSH_HOME。包括 Profiles、凭据、存储与全部会话。仅影响下方插件专用目录，不清理系统 ~/.dsh。',
    detail: `目标 DSH_HOME\n${home || '尚未探测，无法操作'}\n备份保存在 home 之外的宿主管理目录，不随重置删除。`,
    phrase: scope === 'config' ? 'RESET CONFIG' : 'RESET HOME',
    label: scope === 'config' ? '备份并清空配置' : '备份并重置全部',
    danger: true, operation: scope === 'config' ? '清空配置' : '重置 DSH_HOME',
    task: async () => {
      await call('environment.reset', { scope, backup: true, confirmation: scope === 'config' ? 'RESET CONFIG' : 'RESET HOME' })
      if (scope === 'home') {
        window.DshState.commit({ currentSessionId: null, events: [], sessions: [], liveStatus: {}, prefs: { ...window.DshState.state.prefs, quickSessionId: null } })
        await window.DshApi.setPref('quickSessionId', null)
      }
      await controller.refreshHost({ detect: true, sessions: true, settings: true })
      await Promise.all([
        requireLoad(controller.loadBackups()), requireLoad(controller.loadProfiles()), requireLoad(controller.loadSettings()),
      ])
    },
    success: scope === 'config' ? '配置已清空，已有存储、会话与日志保留。重置前备份已保存；进程保持停止。' : 'DSH_HOME 已重置，重置前全量备份保留。进程保持停止。',
  })
  const logs = listData(resources.logs.data)

  return (
    <>
      <SectionHeading title="维护与诊断" description="先备份，再处理配置。所有操作只面向插件当前的 DSH_HOME。" />
      <div className="dsh-settings-target-home"><span>操作目标 / DSH_HOME</span><code>{home || '尚未探测到目标目录，维护操作暂不可用'}</code></div>
      <div className="dsh-settings-layout dsh-settings-maintenance-layout">
        <div className="dsh-settings-stack">
          <Panel
            title="本机备份"
            description="全量快照包括配置、凭据与会话，排除可再生成的依赖目录。备份可能含密钥，仅存本机。"
            actions={<Button variant="primary" disabled={blocked || !home} onClick={() => void createBackup()}><span className="dsh-settings-icon" aria-hidden="true"><IconArchive /></span>创建全量备份</Button>}
          >
            <div className="dsh-settings-backup-toolbar">
              <Segmented value={backupScope} onChange={setBackupScope} ariaLabel="备份范围筛选" options={[{ value: 'all', label: '全部' }, { value: 'home', label: '全量' }, { value: 'profile', label: 'Profile' }]} disabled={blocked} />
              <Button variant="ghost" disabled={blocked || resources.backups.loading} onClick={() => void run('读取备份', () => requireLoad(controller.loadBackups()))}>刷新</Button>
            </div>
            <InlineMessage>{resources.backups.error}</InlineMessage>
            {resources.backups.loading && !resources.backups.loaded ? <LoadingBlock label="正在读取本机备份…" /> : filteredBackups.length ? <div className="dsh-settings-backup-list">
              {filteredBackups.map((entry) => (
                <article className="dsh-settings-backup" key={entry.backupId}>
                  <div className="dsh-settings-backup-copy"><h4>{entry.name || entry.backupId}</h4><p>{formatTime(entry.createdAt)}</p><span>{entry.scope === 'home' ? 'DSH_HOME 全量' : `Profile ${entry.target || ''}`}</span><span className="dsh-settings-mono">{formatBytes(entry.sizeBytes)}</span></div>
                  <div className="dsh-settings-actions"><Button disabled={blocked || !home} onClick={() => restoreBackup(entry)}>恢复</Button><Button variant="ghost" className="dsh-settings-danger-text" disabled={blocked} onClick={() => deleteBackup(entry)}>删除</Button></div>
                </article>
              ))}
            </div> : !resources.backups.error && <EmptyState title={backups.length ? '此范围内没有备份' : '还没有本机备份'}>{backups.length ? '选择其他范围查看。' : '在修改内核或配置之前，建议先创建一次全量快照。'}</EmptyState>}
          </Panel>
          <Panel title="进程日志" description="读取宿主捕获的真实日志尾部，不主动启动进程。">
            <div className="dsh-settings-backup-toolbar">
              <Segmented value={controller.logKind} ariaLabel="日志进程" options={[{ value: 'web', label: 'Web' }, { value: 'sdk', label: 'SDK' }]} disabled={blocked} onChange={(kind) => void controller.selectLogs(kind)} />
              <Button variant="ghost" disabled={blocked || resources.logs.loading} onClick={() => void controller.selectLogs(controller.logKind)}><span className="dsh-settings-icon" aria-hidden="true"><IconRestart /></span>刷新日志</Button>
            </div>
            <InlineMessage>{resources.logs.error}</InlineMessage>
            {resources.logs.loading ? <LoadingBlock label="正在读取日志尾部…" /> : !resources.logs.error && (logs.length ? <pre className="dsh-settings-log" tabIndex={0} aria-label={`${controller.logKind === 'web' ? 'Web' : 'SDK'} 最多 100 行日志`}>{logs.map(redactLog).join('\n')}</pre> : <EmptyState title="当前没有日志输出">尚未启动、宿主重载或进程没有输出时，日志可能为空。</EmptyState>)}
            <p className="dsh-settings-help">最多读取 100 行。已隐藏常见密钥与鉴权格式，但分享日志前仍请检查路径和业务信息。</p>
          </Panel>
        </div>
        <div className="dsh-settings-stack">
          <Panel title="运行详情" className="dsh-settings-quiet-panel" actions={<Button variant="ghost" disabled={blocked} onClick={() => void controller.refreshRuntime()}>刷新</Button>}>
            <Facts items={[
              ['内核版本', state.runtime?.version ? `v${state.runtime.version}` : '未探测'],
              ['来源', sourceLabel(state.runtime?.source)],
              ['执行引擎', state.runtime?.engine],
              ['内核路径', state.runtime?.root],
              ['Web PID', state.status?.web?.pid ?? '未运行'],
              ['Web Profile', state.status?.web?.profile],
              ['SDK PID', state.status?.sdk?.pid ?? '未运行'],
              ['SDK Profile', state.status?.sdk?.profile],
              ['SDK 握手', state.status?.sdk?.running ? state.status.sdk.initialized ? '已完成' : '未完成' : '未运行'],
            ]} />
            <p className="dsh-settings-help">不展示带鉴权参数的 Web 地址，也不读取配置里的环境值。</p>
          </Panel>
          <Panel title="配置恢复" description="先尝试仅清空配置，通常无需删除会话。">
            <p className="dsh-settings-body">清空配置会移除 Profiles、home 补丁、凭据、.env 与启动选择。保留 storages、sessions 与 logs；操作前自动全量备份。</p>
            <Button disabled={blocked || !home} onClick={() => reset('config')}>清空配置，保留会话</Button>
          </Panel>
          <div className="dsh-settings-danger-zone">
            <div className="dsh-settings-heading-copy"><h3>完整重置</h3><p>只有明确需要丢弃当前全部数据时才使用。</p></div>
            <Button variant="ghost" className="dsh-settings-danger-text" disabled={blocked} aria-expanded={showDanger} onClick={() => setShowDanger((value) => !value)}>{showDanger ? '收起完整重置' : '显示完整重置选项'}</Button>
            {showDanger && <div className="dsh-settings-danger-content"><p>整个插件 DSH_HOME 都会被清空，包括全部会话与存储。系统 ~/.dsh 不受影响，重置前备份会保留。</p><Button variant="danger" disabled={blocked || !home} onClick={() => reset('home')}>重置全部数据</Button></div>}
          </div>
        </div>
      </div>
    </>
  )
}
