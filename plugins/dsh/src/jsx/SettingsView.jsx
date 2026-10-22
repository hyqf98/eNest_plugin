import { useId, useState } from 'react'
import { Button } from '@dsh/ui/index.jsx'
import { IconArchive, IconBack, IconPower, IconStack, IconUp } from './icons.jsx'
import { ConfirmAction, InlineMessage } from './SettingsPrimitives.jsx'
import { useSettingsController } from './SettingsController.jsx'
import { SettingsRuntime } from './SettingsRuntime.jsx'
import { SettingsVersions } from './SettingsVersions.jsx'
import { SettingsProfiles } from './SettingsProfiles.jsx'
import { SettingsMaintenance } from './SettingsMaintenance.jsx'
import '@dsh/css/settings.css'

const SECTIONS = [
  { value: 'runtime', label: '运行', Icon: IconPower },
  { value: 'versions', label: '内核版本', Icon: IconUp },
  { value: 'profiles', label: 'Profiles', Icon: IconStack },
  { value: 'maintenance', label: '维护与诊断', Icon: IconArchive },
]

export function SettingsView({ state, onBack }) {
  const controller = useSettingsController(state)
  const [editorDirty, setEditorDirty] = useState(false)
  const id = useId()
  const blocked = Boolean(controller.pending)
  const web = state.status?.web
  const sdk = state.status?.sdk
  const navigate = (next) => {
    if (blocked || next === controller.section) return
    const change = () => {
      setEditorDirty(false)
      controller.setSection(next)
    }
    if (editorDirty) return controller.ask({
      title: '放弃未保存的 Profile 更改？',
      description: '当前组合层、补丁或环境变量尚未保存。离开不会修改磁盘中的配置。',
      label: '放弃并离开', danger: true, task: change,
    })
    change()
  }
  const back = () => {
    if (blocked) return
    if (editorDirty) return controller.ask({
      title: '放弃未保存的 Profile 更改并返回？',
      description: '未保存的编辑内容将被丢弃，磁盘中的配置与运行进程不会因此更改。',
      label: '放弃并返回', danger: true, task: onBack,
    })
    onBack()
  }
  const changeTabWithKeys = (event, index) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || blocked) return
    event.preventDefault()
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
    document.getElementById(`${id}-tab-${SECTIONS[nextIndex].value}`)?.focus()
    navigate(SECTIONS[nextIndex].value)
  }

  return (
    <div className="dsh-settings" aria-label="DSH 管理中心">
      <a className="dsh-settings-skip" href={`#${id}-panel`}>跳至管理内容</a>
      <header className="dsh-settings-header">
        <div className="dsh-settings-header-title">
          <Button variant="ghost" className="dsh-settings-back" disabled={blocked} onClick={back} aria-label="返回 DSH 工作区"><span className="dsh-settings-icon" aria-hidden="true"><IconBack /></span></Button>
          <div><h1>管理中心<span>DSH</span></h1><p>运行、配置与恢复</p></div>
        </div>
        <div className="dsh-settings-header-status" aria-label="当前进程概况">
          <span className={`dsh-settings-header-process${web?.running ? ' is-running' : ''}`}><span aria-hidden="true" />Web <strong>{state.webBooting ? '启动中' : web?.running ? '运行中' : web ? '已停止' : '未读取'}</strong></span>
          <span className={`dsh-settings-header-process${sdk?.running ? ' is-running' : ''}`}><span aria-hidden="true" />SDK <strong>{sdk?.running ? sdk.initialized ? '运行中' : '初始化中' : sdk ? '已停止' : '未读取'}</strong></span>
        </div>
      </header>
      <nav className="dsh-settings-navigation" aria-label="管理中心分区">
        <div className="dsh-settings-tabs" role="tablist" aria-label="管理中心分区">
          {SECTIONS.map(({ value, label, Icon }, index) => (
            <Button
              key={value} variant="ghost" className="dsh-settings-tab" role="tab"
              id={`${id}-tab-${value}`} aria-selected={controller.section === value}
              aria-controls={`${id}-panel`} tabIndex={controller.section === value ? 0 : -1}
              disabled={blocked} onClick={() => navigate(value)} onKeyDown={(event) => changeTabWithKeys(event, index)}
            ><span className="dsh-settings-icon" aria-hidden="true"><Icon /></span>{label}</Button>
          ))}
        </div>
        <span className="dsh-settings-nav-version">{state.runtime?.version ? `v${state.runtime.version}` : '内核待探测'}</span>
      </nav>
      <main
        className="dsh-settings-main" id={`${id}-panel`} role="tabpanel"
        aria-labelledby={`${id}-tab-${controller.section}`} aria-busy={blocked} tabIndex={-1}
      >
        <div className="dsh-settings-content">
          <div className="dsh-settings-feedback" aria-live="polite" aria-atomic="true">
            {controller.pending && <div className="dsh-settings-operation" role="status"><span className="dsh-settings-operation-mark" aria-hidden="true" /><strong>{controller.pending}</strong><span>正在处理，请勿关闭当前页面。</span></div>}
            {controller.message && <InlineMessage kind={controller.message.kind} actions={<Button variant="ghost" onClick={() => controller.setMessage(null)} disabled={blocked} aria-label="关闭操作提示">关闭</Button>}>{controller.message.text}</InlineMessage>}
          </div>
          {controller.section === 'runtime' && <SettingsRuntime state={state} controller={controller} />}
          {controller.section === 'versions' && <SettingsVersions state={state} controller={controller} />}
          {controller.section === 'profiles' && <SettingsProfiles state={state} controller={controller} editorDirty={editorDirty} setEditorDirty={setEditorDirty} />}
          {controller.section === 'maintenance' && <SettingsMaintenance state={state} controller={controller} />}
        </div>
      </main>
      <ConfirmAction
        confirmation={controller.confirmation} phrase={controller.phrase} setPhrase={controller.setPhrase}
        pending={blocked} error={controller.confirmationError} onClose={controller.closeConfirmation} onConfirm={() => void controller.confirm()}
      />
    </div>
  )
}

export default SettingsView
