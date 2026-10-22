import { useCallback, useId, useState } from 'react'
import { Button, Input, Select } from '@dsh/ui/index.jsx'
import { IconPlus, IconRestart } from './icons.jsx'
import { EmptyState, Field, InlineMessage, LoadingBlock, Panel, SectionHeading } from './SettingsPrimitives.jsx'
import { listData } from './SettingsController.jsx'
import { SettingsProfileEditor } from './SettingsProfileEditor.jsx'

const TEMPLATES = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'].map((value) => ({ value, label: value }))

export function SettingsProfiles({ state, controller, editorDirty, setEditorDirty }) {
  const { resources, pending, run, ask, call, requireLoad } = controller
  const profiles = listData(resources.profiles.data)
  const settings = resources.settings.data
  const [selected, setSelected] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('web')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [validation, setValidation] = useState('')
  const id = useId()
  const blocked = Boolean(pending)
  const onDirtyChange = useCallback((dirty) => setEditorDirty(dirty), [setEditorDirty])
  const selectedSummary = profiles.find((profile) => profile.name === selected)
  const profile = resources.profile.data?.name === selected ? resources.profile.data : null
  const selectedForRole = (profileName) => settings?.webProfile === profileName || settings?.sdkProfile === profileName
  const runningProfile = (profileName) => ['web', 'sdk'].some((kind) => state.status?.[kind]?.running && state.status[kind].profile === profileName)

  const refresh = () => run('刷新 Profiles', async () => {
    await requireLoad(controller.loadProfiles())
    await requireLoad(controller.loadSettings())
  })
  const read = async (profileName) => {
    setSelected(profileName)
    setCreating(false)
    setEditorDirty(false)
    await requireLoad(controller.loadProfile(profileName))
  }
  const pick = (profileName) => {
    if (selected === profileName && profile && !resources.profile.error) return
    if (editorDirty) return ask({
      title: '放弃未保存的 Profile 更改？',
      description: '当前组合层、补丁或环境变量的更改尚未保存。切换只会重新读取配置，不会写入磁盘。',
      label: '放弃并切换', danger: true,
      task: () => read(profileName),
    })
    void run('读取 Profile', () => read(profileName))
  }
  const create = (event) => {
    event.preventDefault()
    setValidation('')
    const nextName = name.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(nextName) || nextName === 'desktop') return setValidation('名称须以字母或数字开头，限 64 字符，可含 . _ -；desktop 为保留名。')
    if (profiles.some((item) => item.name === nextName)) return setValidation('这个名称已存在，请使用其他名称。')
    const task = async () => {
      await call('profiles.create', { name: nextName, template })
      await requireLoad(controller.loadProfiles())
      setName('')
      await read(nextName)
    }
    if (editorDirty) return ask({ title: '放弃未保存更改并创建？', description: '当前 Profile 的更改不会保存。新 Profile 会从所选模板创建，不会启动 Web 或 SDK。', label: '创建 Profile', task, success: 'Profile 已创建，尚未用于运行。' })
    void run('创建 Profile', task, 'Profile 已创建，尚未用于运行。')
  }
  const backup = (profileName) => ask({
    title: `停止进程并备份 ${profileName}？`,
    description: '为保证配置快照一致，宿主会停止 Web 与 SDK。正在进行的对话可能中断，会话文件不会删除。',
    label: '停止并备份', operation: '备份 Profile',
    task: async () => {
      await call('profiles.backup', { name: profileName })
      await controller.refreshHost()
      await requireLoad(controller.loadBackups())
    },
    success: 'Profile 已备份，进程保持停止；可在「维护与诊断」查看备份。',
  })
  const remove = (profileName) => ask({
    title: `删除 ${profileName}？`,
    description: '宿主会停止 Web 与 SDK，备份此 Profile 后移除配置目录。会话文件保留。已被选为启动角色的 Profile 不可删除。',
    detail: `profiles/${profileName}`,
    label: '备份并删除', danger: true,
    task: async () => {
      await call('profiles.delete', { name: profileName, backupFirst: true })
      await controller.refreshHost()
      setSelected('')
      setEditorDirty(false)
      await requireLoad(controller.loadProfiles())
      await requireLoad(controller.loadBackups())
    },
    success: 'Profile 已删除，删除前备份保留。',
  })
  const sync = (event) => {
    event.preventDefault()
    setValidation('')
    if (!source || !target || source === target) return setValidation('请选择不同的源 Profile 与目标 Profile。')
    ask({
      title: `将 ${source} 的环境同步到 ${target}？`,
      description: '仅复制 API Key、代理与其他受支持的环境变量，保留目标的组合层、YAML 补丁与依赖。宿主会先备份目标，再覆盖环境并停止 Web 与 SDK。目标中的原有环境凭据可能被替换。这是一次性同步。',
      detail: `${source} → ${target}${editorDirty && selected === target ? '；目标编辑器内尚未保存的更改也将放弃。' : ''}`,
      label: '备份目标并同步', danger: true,
      task: async () => {
        await call('profiles.sync', { source, target })
        await controller.refreshHost({ settings: true })
        await requireLoad(controller.loadProfiles())
        await requireLoad(controller.loadBackups())
        if (selected === target) {
          setEditorDirty(false)
          await requireLoad(controller.loadProfile(target))
        }
      },
      success: '目标环境已备份并同步，组合层、补丁与依赖保留。Web 与 SDK 已停止，请按需手动启动。',
    })
  }
  const mutableProfiles = profiles.filter((item) => !item.reserved)
  const sourceOptions = mutableProfiles.map((item) => ({ value: item.name, label: item.name }))
  const targetOptions = mutableProfiles.filter((item) => item.name !== source).map((item) => ({ value: item.name, label: item.name }))

  return (
    <>
      <SectionHeading
        title="Profiles"
        description="Profile 是组合层、YAML 补丁与插件依赖的集合。运行角色在「运行」中单独选择。"
        actions={<><Button variant="ghost" disabled={blocked || resources.profiles.loading} onClick={() => void refresh()}><span className="dsh-settings-icon" aria-hidden="true"><IconRestart /></span>刷新</Button><Button disabled={blocked} onClick={() => setCreating((value) => !value)}><span className="dsh-settings-icon" aria-hidden="true"><IconPlus /></span>{creating ? '收起创建' : '创建 Profile'}</Button></>}
      />
      <InlineMessage>{resources.profiles.error}</InlineMessage>
      <InlineMessage>{resources.settings.error ? `无法读取启动角色：${resources.settings.error}。相关删除操作已禁用。` : ''}</InlineMessage>
      {creating && <Panel title="从模板创建" description="创建只写入 Profile，不会自动切换启动角色或运行进程。">
        <form className="dsh-settings-create-form" onSubmit={create}>
          <Field label="Profile 名称" htmlFor={`${id}-name`}><Input id={`${id}-name`} autoComplete="off" spellCheck={false} maxLength={64} value={name} disabled={blocked} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="来源模板"><Select ariaLabel="来源模板" value={template} options={TEMPLATES} disabled={blocked} onChange={setTemplate} /></Field>
          <Button type="submit" variant="primary" disabled={blocked || !name.trim()}>创建</Button>
        </form>
      </Panel>}
      <InlineMessage>{validation}</InlineMessage>
      <div className="dsh-settings-layout dsh-settings-profiles-layout">
        <div className="dsh-settings-stack">
          <Panel title="配置集合" description="选择后才会读取补丁与环境值。">
            {resources.profiles.loading && !resources.profiles.loaded ? <LoadingBlock label="正在读取 Profiles…" /> : profiles.length ? <div className="dsh-settings-profile-list">
              {profiles.map((item) => (
                <Button key={item.name} variant="ghost" className={`dsh-settings-profile-choice${selected === item.name ? ' is-selected' : ''}`} disabled={blocked} aria-pressed={selected === item.name} onClick={() => pick(item.name)}>
                  <span className="dsh-settings-profile-choice-heading"><strong>{item.name}</strong><span>{item.exists === false ? '模板' : item.builtin ? '内置模板' : '自定义'}</span></span>
                  <span className="dsh-settings-profile-capabilities">{item.webCompatible ? 'Web' : ''}{item.webCompatible && item.sdkCompatible ? ' / ' : ''}{item.sdkCompatible ? 'SDK' : ''}{!item.webCompatible && !item.sdkCompatible ? '其他运行模式' : ''}{item.exists === false ? '，未初始化' : ''}</span>
                  {(settings?.webProfile === item.name || settings?.sdkProfile === item.name) && <span className="dsh-settings-role-flags">{settings?.webProfile === item.name && <span>Web 下次启动</span>}{settings?.sdkProfile === item.name && <span>SDK 下次启动</span>}</span>}
                  {runningProfile(item.name) && <span className="dsh-settings-help">当前进程使用中</span>}
                  {item.error && <span className="dsh-settings-inline-error">{item.error}</span>}
                </Button>
              ))}
            </div> : !resources.profiles.error && <EmptyState title="还没有可用的 Profile">从模板创建配置后，在「运行」选择对应角色。</EmptyState>}
          </Panel>
          <Panel title="一键同步环境" description="仅同步凭据与代理等环境覆盖，保留目标运行角色与组合层。">
            <form className="dsh-settings-form" onSubmit={sync}>
              <Field label="源 Profile"><Select value={source} ariaLabel="同步源 Profile" options={sourceOptions} disabled={blocked || !sourceOptions.length} onChange={(value) => { setSource(value); if (value === target) setTarget('') }} /></Field>
              <Field label="目标 Profile"><Select value={target} ariaLabel="同步目标 Profile" options={targetOptions} disabled={blocked || !source || !targetOptions.length} onChange={setTarget} /></Field>
              <p className="dsh-settings-help">仅限当前 DSH_HOME 内的 Profile。不会读取系统 ~/.dsh。</p>
              <Button type="submit" disabled={blocked || !source || !target || source === target}>备份目标并同步</Button>
            </form>
          </Panel>
        </div>
        <div className="dsh-settings-stack">
          {!selected ? <Panel><EmptyState title="选择一个 Profile 查看配置">组合层决定基础能力，YAML 补丁覆盖配置，环境变量仅影响此 Profile 的子进程。API Key 默认隐藏。</EmptyState></Panel> : <>
            {resources.profile.loading ? <Panel><LoadingBlock label={`正在读取 ${selected}…`} /></Panel> : resources.profile.error ? <Panel title={selected}><InlineMessage>{resources.profile.error}</InlineMessage><Button disabled={blocked} onClick={() => void run('重新读取 Profile', () => read(selected))}>重新读取</Button></Panel> : profile ? <SettingsProfileEditor profile={profile} controller={controller} onSaved={(profileName) => requireLoad(controller.loadProfile(profileName))} onDirtyChange={onDirtyChange} /> : <Panel><EmptyState title="配置尚未读取" /></Panel>}
            {selectedSummary && <Panel className="dsh-settings-quiet-panel" title="Profile 操作">
              <div className="dsh-settings-actions">
                <Button disabled={blocked || selectedSummary.reserved || selectedSummary.exists === false} onClick={() => void backup(selected)}>备份此 Profile</Button>
                <Button variant="ghost" className="dsh-settings-danger-text" disabled={blocked || selectedSummary.reserved || selectedSummary.exists === false || selectedForRole(selected) || runningProfile(selected) || Boolean(resources.settings.error) || !resources.settings.loaded} onClick={() => remove(selected)}>删除 Profile</Button>
              </div>
              {(selectedForRole(selected) || runningProfile(selected)) && <p className="dsh-settings-help">该 Profile 已选作启动角色或正被进程使用。请先在「运行」更换角色并停止进程，再删除。</p>}
              {selectedSummary.exists === false && <p className="dsh-settings-help">这是未初始化的模板，尚无可备份或删除的目录。</p>}
            </Panel>}
          </>}
        </div>
      </div>
    </>
  )
}
