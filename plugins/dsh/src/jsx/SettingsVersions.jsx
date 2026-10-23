import { Button } from '@dsh/ui/index.jsx'
import { IconRestart, IconUp } from './icons.jsx'
import { EmptyState, InlineMessage, InstallProgress, LoadingBlock, Panel, SectionHeading } from './SettingsPrimitives.jsx'
import { formatTime, listData, sourceLabel, versionKey } from './SettingsController.jsx'

export function SettingsVersions({ state, controller }) {
  const { resources, pending, call, run, ask, requireLoad, refreshHost } = controller
  const installed = listData(resources.versions.data)
  const remote = listData(resources.remote.data)
  const hasBundled = installed.some((item) => (item.channel || item.source) === 'bundled')
  const blocked = Boolean(pending)
  const refreshLocal = () => run('读取本地内核', () => requireLoad(controller.loadVersions()))
  const refreshRemote = () => run('获取远程版本', () => requireLoad(controller.loadRemote()))
  const refreshAfterChange = async () => {
    await refreshHost({ detect: true, settings: true })
    await requireLoad(controller.loadVersions())
  }
  const activate = (version) => ask({
    title: `切换到 v${version.version}？`,
    description: '切换会停止 Web 与 SDK 并检查目标内核。已有 Profile 与会话保留；切换后请按需手动启动。',
    detail: `${sourceLabel(version.channel || version.source)} / ${version.path || version.version}`,
    label: '切换内核',
    operation: '切换内核',
    task: async () => {
      await call('runtime.activate', { version: version.version, source: version.channel || version.source })
      await refreshAfterChange()
    },
    success: '内核已切换。Web 与 SDK 保持停止，可在「运行」中手动启动。',
  })
  const remove = (version) => ask({
    title: `移除 v${version.version} 的本地安装？`,
    description: '宿主会先停止 Web 与 SDK，再删除此内核安装。Profile、凭据、会话与备份保留。当前使用版本不可移除。',
    label: '移除安装', danger: true,
    task: async () => {
      await call('runtime.remove', { version: version.version })
      await refreshHost()
      await requireLoad(controller.loadVersions())
    },
    success: '本地安装已移除，用户数据保留。',
  })
  const download = (version) => run(`下载 v${version.version}`, async () => {
    await call('runtime.download', { version: version.version })
    await requireLoad(controller.loadVersions())
  }, '下载与校验已完成。尚未切换正在使用的内核。')
  const upgrade = (version) => ask({
    title: `升级到 v${version.version}？`,
    description: '宿主将停止进程，创建 DSH_HOME 全量备份，再下载、校验、激活并检查内核。失败会尝试回滚。请先结束正在进行的对话。',
    detail: state.runtime?.dshHome || 'DSH_HOME 尚未探测',
    label: '备份并升级',
    operation: `升级 v${version.version}`,
    task: async () => {
      await call('upgrade.oneClick', { version: version.version })
      await refreshAfterChange()
      await requireLoad(controller.loadBackups())
    },
    success: '内核已升级并通过入口检查。Web 与 SDK 保持停止，请在「运行」中手动启动。',
  })
  const installPending = pending && (/下载|升级|内核/.test(pending))

  return (
    <>
      <SectionHeading title="内核版本" description="保留可回退的本地版本。远程列表只在你主动获取时联网。" />
      <div className="dsh-settings-layout dsh-settings-version-layout">
        <div className="dsh-settings-stack">
          <Panel
            title="本地内核"
            description={hasBundled ? '按来源区分同版本安装。存在兼容的内置内核时，可切回内置版。' : '发行包不再内置内核；本地版本来自你的在线安装。'}
            actions={<Button variant="ghost" disabled={blocked || resources.versions.loading} onClick={() => void refreshLocal()}><span className="dsh-settings-icon" aria-hidden="true"><IconRestart /></span>刷新</Button>}
          >
            <InlineMessage>{resources.versions.error}</InlineMessage>
            {resources.versions.loading && !resources.versions.loaded ? <LoadingBlock label="正在读取本地内核…" /> : installed.length ? (
              <div className="dsh-settings-version-list">
                {installed.map((version) => {
                  const source = version.channel || version.source
                  return (
                    <article key={versionKey(version)} className={`dsh-settings-version${version.active ? ' is-active' : ''}`}>
                      <div className="dsh-settings-row">
                        <div className="dsh-settings-version-name"><strong>v{version.version}</strong><span>{sourceLabel(source)}</span></div>
                        {version.active && <span className="dsh-settings-status is-running">当前使用</span>}
                      </div>
                      {(version.path || version.installedAt) && <p className="dsh-settings-version-path">{version.path || formatTime(version.installedAt)}</p>}
                      <div className="dsh-settings-actions">
                        {!version.active && <Button disabled={blocked} onClick={() => activate(version)}>{source === 'bundled' ? '回退到内置版' : '切换到此版本'}</Button>}
                        {source === 'data' && !version.active && <Button variant="ghost" className="dsh-settings-danger-text" disabled={blocked} onClick={() => remove(version)}>移除</Button>}
                        {version.active && <span className="dsh-settings-help">运行设置与会话独立于内核安装。</span>}
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : !resources.versions.error && <EmptyState title="未发现本地内核">{hasBundled ? '先获取远程版本并下载可校验的资产，或检查插件内置内核。' : '在下方获取远程版本，下载带校验信息的资产安装即可。'}</EmptyState>}
          </Panel>
          <Panel
            title="远程版本"
            description="仅带下载资产与 SHA-256 校验信息的版本可安装。"
            actions={<Button disabled={blocked || resources.remote.loading} onClick={() => void refreshRemote()}><span className="dsh-settings-icon" aria-hidden="true"><IconUp /></span>{resources.remote.loaded ? '重新获取' : '获取版本'}</Button>}
          >
            <InlineMessage>{resources.remote.error ? `远程列表获取失败：${resources.remote.error}${remote.length ? '。下方保留上次成功获取的列表。' : ''}` : ''}</InlineMessage>
            {resources.remote.loading ? <LoadingBlock label="正在获取远程版本与资产信息…" /> : remote.length ? (
              <div className="dsh-settings-remote-list">
                {remote.map((version) => {
                  const verified = Boolean(version.assetUrl && /^[a-f\d]{64}$/i.test(version.sha256 || ''))
                  const local = installed.some((item) => item.version === version.version && (item.channel || item.source) === 'data')
                  return (
                    <article className="dsh-settings-remote-version" key={version.version}>
                      <div className="dsh-settings-heading-copy">
                        <div className="dsh-settings-version-name"><strong>v{version.version}</strong>{version.distTag && <span>{version.distTag}</span>}</div>
                        <p>{version.date ? formatTime(version.date) : '发布时间未提供'}</p>
                        <span className="dsh-settings-help">{local ? '已安装到本地' : verified ? '提供 SHA-256 校验信息' : '缺少下载资产或校验信息，不可安装'}</span>
                      </div>
                      <div className="dsh-settings-actions">
                        {!local && verified && <Button disabled={blocked} onClick={() => void download(version)}>仅下载</Button>}
                        {verified && <Button variant="primary" disabled={blocked || installed.some((item) => item.active && item.version === version.version && (item.channel || item.source) === 'data')} onClick={() => upgrade(version)}>备份并升级</Button>}
                      </div>
                    </article>
                  )
                })}
              </div>
            ) : <EmptyState title={resources.remote.loaded ? '当前没有可用的远程版本' : '尚未获取远程版本'}>{resources.remote.loaded ? '可以稍后重新获取。本地内核不受影响。' : '获取列表不会下载内核，也不会改变当前版本。'}</EmptyState>}
          </Panel>
        </div>
        <aside className="dsh-settings-stack" aria-label="内核状态与升级说明">
          <Panel className="dsh-settings-quiet-panel" title="当前使用">
            <div className="dsh-settings-current-version">{state.runtime?.version ? <><span>v</span>{state.runtime.version}</> : '不可用'}</div>
            <p className="dsh-settings-help">{sourceLabel(state.runtime?.source)}</p>
            <p className="dsh-settings-path">{state.runtime?.root || '尚未探测到内核路径'}</p>
          </Panel>
          <InstallProgress progress={state.upgrading} pending={installPending ? pending : null} />
          <div className="dsh-settings-note">
            <h3>下载与升级的区别</h3>
            <p>「仅下载」只安装文件，不激活内核。「备份并升级」包含停止、备份与健康检查。</p>
            <p>回退到内置版（存在时）会保留 DSH_HOME。内核兼容性问题与配置问题应分别处理。</p>
          </div>
        </aside>
      </div>
    </>
  )
}
