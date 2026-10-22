import { useEffect, useId, useState } from 'react'
import { Button, Input, Select, Segmented } from '@dsh/ui/index.jsx'
import { IconPower, IconRestart } from './icons.jsx'
import { EmptyState, Facts, Field, InlineMessage, LoadingBlock, Panel, SectionHeading } from './SettingsPrimitives.jsx'
import { formatTime, listData, sourceLabel } from './SettingsController.jsx'

function Process({ kind, state, settings, controller }) {
  const info = state.status?.[kind]
  const isWeb = kind === 'web'
  const error = info?.lastError || (!isWeb ? state.sdkError : null)
  const starting = isWeb && state.webBooting
  const status = error ? '需要处理' : starting ? '正在启动' : info?.running ? (isWeb || info.initialized ? '运行中' : '初始化中') : info ? '已停止' : '状态待刷新'
  const profile = info?.profile
  const selectedProfile = isWeb ? settings?.webProfile : settings?.sdkProfile
  const disabled = Boolean(controller.pending)
  return (
    <article className="dsh-settings-process">
      <div className="dsh-settings-process-heading">
        <div className="dsh-settings-process-title">
          <span className="dsh-settings-icon" aria-hidden="true"><IconPower /></span>
          <div><h3>{isWeb ? 'Web 完全体' : 'SDK 快速对话'}</h3><p>{isWeb ? '完整工作区与模型配置' : '轻量会话与宿主交互'}</p></div>
        </div>
        <span className={`dsh-settings-status${error ? ' is-error' : info?.running ? ' is-running' : ''}`}>{status}</span>
      </div>
      <dl className="dsh-settings-process-facts">
        <div><dt>运行 Profile</dt><dd>{info?.running ? profile || '宿主未提供' : '未运行'}</dd></div>
        <div><dt>下次启动</dt><dd>{selectedProfile || '未读取'}</dd></div>
        <div><dt>{isWeb ? '本地端口' : '进程 PID'}</dt><dd>{isWeb ? (info?.port ? `127.0.0.1:${info.port}` : '未分配') : info?.pid ?? '未启动'}</dd></div>
      </dl>
      {info?.portRetries > 0 && <p className="dsh-settings-help">端口占用，已自动换口 {info.portRetries} 次。</p>}
      <InlineMessage>{error}</InlineMessage>
      <div className="dsh-settings-actions">
        <Button variant={info?.running ? undefined : 'primary'} disabled={disabled || starting || info?.running || state.runtime?.available === false} onClick={() => void controller.processAction(kind, 'start')}>启动</Button>
        <Button disabled={disabled || state.runtime?.available === false} onClick={() => controller.ask({
          title: `重启 ${isWeb ? 'Web' : 'SDK'}？`,
          description: '当前进程会先停止，再按已保存的 Profile 与运行设置启动。正在进行的对话可能中断。',
          label: '重启进程',
          operation: `重启 ${isWeb ? 'Web' : 'SDK'}`,
          task: async () => {
            const method = isWeb ? 'restartWeb' : 'restartSdk'
            await window.DshState[method]()
            await window.DshState.refreshStatus()
          },
          success: '重启请求已完成。请查看进程状态与日志。',
        })}><span className="dsh-settings-icon" aria-hidden="true"><IconRestart /></span>重启</Button>
        <Button variant="ghost" disabled={disabled} onClick={() => controller.ask({
          title: `停止 ${isWeb ? 'Web' : 'SDK'}？`,
          description: '正在进行的对话可能中断。已有会话文件不会被删除，之后可手动重新启动。',
          label: '停止进程',
          operation: `停止 ${isWeb ? 'Web' : 'SDK'}`,
          task: async () => {
            await window.DshState[isWeb ? 'stopWeb' : 'stopSdk']()
            await window.DshState.refreshStatus()
          },
          success: '进程已停止，会话文件保留。',
        })}>停止</Button>
      </div>
    </article>
  )
}

export function SettingsRuntime({ state, controller }) {
  const { resources, pending } = controller
  const settings = resources.settings.data
  const profiles = listData(resources.profiles.data)
  const [draft, setDraft] = useState(null)
  const [routing, setRouting] = useState({ provider: state.prefs?.provider || '', model: state.prefs?.model || '' })
  const [validation, setValidation] = useState('')
  const [routingValidation, setRoutingValidation] = useState('')
  const portId = useId()
  const providerId = useId()
  const modelId = useId()
  useEffect(() => {
    if (settings) setDraft({ ...settings, webPort: String(settings.webPort ?? 3000) })
  }, [settings])
  useEffect(() => {
    setRouting({ provider: state.prefs?.provider || '', model: state.prefs?.model || '' })
  }, [state.prefs?.provider, state.prefs?.model])

  const roleOptions = (kind) => {
    const key = `${kind}Profile`
    const options = profiles.filter((profile) => profile[`${kind}Compatible`] === true).map((profile) => ({
      value: profile.name,
      label: `${profile.name}${profile.exists === false ? '（模板，未初始化）' : ''}`,
    }))
    if (draft?.[key] && !options.some((option) => option.value === draft[key])) {
      options.unshift({ value: draft[key], label: `${draft[key]}（不可用或不兼容）`, disabled: true })
    }
    return options
  }
  const settingsDirty = Boolean(draft && settings && (
    draft.webProfile !== settings.webProfile || draft.sdkProfile !== settings.sdkProfile ||
    draft.webPortPolicy !== settings.webPortPolicy || Number(draft.webPort) !== settings.webPort
  ))
  const routingDirty = routing.provider !== (state.prefs?.provider || '') || routing.model !== (state.prefs?.model || '')
  const saveRuntime = (event) => {
    event.preventDefault()
    setValidation('')
    if (!profiles.some((profile) => profile.name === draft.webProfile && profile.webCompatible)) return setValidation('请选择支持 Web 的 Profile。')
    if (!profiles.some((profile) => profile.name === draft.sdkProfile && profile.sdkCompatible)) return setValidation('请选择支持 SDK 的 Profile。')
    const port = Number(draft.webPort)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return setValidation('端口须为 1024 到 65535 之间的整数。')
    controller.saveSettings({ webProfile: draft.webProfile, sdkProfile: draft.sdkProfile, webPortPolicy: draft.webPortPolicy, webPort: port })
  }
  const saveRouting = (event) => {
    event.preventDefault()
    setRoutingValidation('')
    const provider = routing.provider.trim()
    const model = routing.model.trim()
    if (!provider || !model) return setRoutingValidation('请填写 provider 与 model，值需与 DSH 中的模型配置一致。')
    void controller.saveModel({ provider, model })
  }

  return (
    <>
      <SectionHeading
        title="运行与连接"
        description="同一套配置服务于快速对话与完全体。管理中心不会自动启动任何进程。"
        actions={<Button disabled={Boolean(pending)} onClick={() => void controller.refreshRuntime()}><span className="dsh-settings-icon" aria-hidden="true"><IconRestart /></span>刷新状态</Button>}
      />
      {state.runtime?.available === false && <InlineMessage>{state.runtime.error || '未找到可用的 DSH 内核。请在「内核版本」安装或切换本地版本。'}</InlineMessage>}
      <div className="dsh-settings-layout dsh-settings-runtime-layout">
        <div className="dsh-settings-stack">
          <Panel title="进程" description="启动是显式操作；停止或失败后仍可从这里重启。">
            <div className="dsh-settings-processes">
              <Process kind="web" state={state} settings={settings} controller={controller} />
              <Process kind="sdk" state={state} settings={settings} controller={controller} />
            </div>
          </Panel>
          <Panel title="下次启动设置" description="由宿主持久化。保存会停止 Web 与 SDK，之后由你手动启动。">
            <InlineMessage>{resources.settings.error}</InlineMessage>
            <InlineMessage>{resources.profiles.error}</InlineMessage>
            {!draft ? (resources.settings.loading ? <LoadingBlock label="正在读取运行设置…" /> : <EmptyState title="运行设置尚未读取" action={<Button disabled={Boolean(pending)} onClick={() => void controller.run('读取运行设置', () => controller.requireLoad(controller.loadSettings()))}>重新读取</Button>} />) : (
              <form className="dsh-settings-form" onSubmit={saveRuntime}>
                <fieldset disabled={Boolean(pending) || resources.profiles.loading || Boolean(resources.profiles.error)}>
                  <div className="dsh-settings-form-grid">
                    <Field label="Web Profile" hint="仅显示包含 Web 运行能力的组合。">
                      <Select ariaLabel="Web Profile" value={draft.webProfile} options={roleOptions('web')} onChange={(webProfile) => setDraft((current) => ({ ...current, webProfile }))} disabled={Boolean(pending) || resources.profiles.loading || Boolean(resources.profiles.error)} />
                    </Field>
                    <Field label="SDK Profile" hint="仅显示包含 SDK 运行能力的组合。">
                      <Select ariaLabel="SDK Profile" value={draft.sdkProfile} options={roleOptions('sdk')} onChange={(sdkProfile) => setDraft((current) => ({ ...current, sdkProfile }))} disabled={Boolean(pending) || resources.profiles.loading || Boolean(resources.profiles.error)} />
                    </Field>
                  </div>
                  <Field label="Web 端口分配" hint={draft.webPortPolicy === 'auto' ? '每次启动由宿主选择可用端口，无需手动维护。' : '优先使用指定端口；如被占用，宿主会自动换到可用端口。不是严格固定端口。'}>
                    <Segmented ariaLabel="Web 端口分配" value={draft.webPortPolicy} onChange={(webPortPolicy) => setDraft((current) => ({ ...current, webPortPolicy }))} options={[{ value: 'auto', label: '自动分配' }, { value: 'fixed', label: '首选端口' }]} disabled={Boolean(pending)} />
                  </Field>
                  {draft.webPortPolicy === 'fixed' && <Field label="首选端口" htmlFor={portId}>
                    <Input id={portId} className="dsh-settings-port-input" type="number" min="1024" max="65535" step="1" value={draft.webPort} onChange={(event) => setDraft((current) => ({ ...current, webPort: event.target.value }))} />
                  </Field>}
                </fieldset>
                <InlineMessage>{validation}</InlineMessage>
                <div className="dsh-settings-form-footer">
                  <span>{settingsDirty ? '有未保存的更改' : '已与宿主设置同步'}</span>
                  <Button type="submit" variant="primary" disabled={Boolean(pending) || !settingsDirty || resources.profiles.loading || Boolean(resources.profiles.error)}>保存运行设置</Button>
                </div>
              </form>
            )}
          </Panel>
        </div>
        <div className="dsh-settings-stack">
          <Panel title="快速对话的模型路由" description="填写 DSH 中已配置的标识。此处只保存路由，不保存 API Key。">
            <form className="dsh-settings-form" onSubmit={saveRouting}>
              <fieldset disabled={Boolean(pending)}>
                <Field label="Provider" htmlFor={providerId} hint="与完全体 Models 中的 provider 标识一致。"><Input id={providerId} value={routing.provider} autoComplete="off" spellCheck={false} onChange={(event) => setRouting((current) => ({ ...current, provider: event.target.value }))} /></Field>
                <Field label="Model" htmlFor={modelId}><Input id={modelId} value={routing.model} autoComplete="off" spellCheck={false} onChange={(event) => setRouting((current) => ({ ...current, model: event.target.value }))} /></Field>
              </fieldset>
              <InlineMessage>{routingValidation}</InlineMessage>
              <Button type="submit" disabled={Boolean(pending) || !routingDirty}>保存模型路由</Button>
            </form>
          </Panel>
          <Panel title="当前内核" className="dsh-settings-quiet-panel">
            <div className="dsh-settings-current-version">{state.runtime?.version ? <><span>v</span>{state.runtime.version}</> : '未探测'}</div>
            <Facts items={[
              ['来源', sourceLabel(state.runtime?.source)],
              ['引擎', state.runtime?.engine],
              ['Web 启动于', state.status?.web?.startedAt ? formatTime(state.status.web.startedAt) : '未运行'],
            ]} />
            <p className="dsh-settings-help">更换内核、回退内置版与下载校验请前往「内核版本」。</p>
            <Button variant="ghost" disabled={Boolean(pending)} onClick={() => controller.setSection('versions')}>管理内核版本</Button>
          </Panel>
        </div>
      </div>
    </>
  )
}
