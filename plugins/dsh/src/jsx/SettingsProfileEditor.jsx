import { useEffect, useId, useState } from 'react'
import { Button, Input, Select, Segmented } from '@dsh/ui/index.jsx'
import { Field, InlineMessage, Panel } from './SettingsPrimitives.jsx'

const ENVIRONMENT_KEYS = [
  'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'DSH_TELEMETRY_DISABLED',
]
const ENVIRONMENT_HELP = {
  DEEPSEEK_API_KEY: 'DeepSeek API Key', DEEPSEEK_BASE_URL: 'DeepSeek http(s) API 地址，不含账号密码或片段',
  OPENAI_API_KEY: 'OpenAI API Key', ANTHROPIC_API_KEY: 'Anthropic API Key',
  HTTP_PROXY: 'HTTP 代理地址', HTTPS_PROXY: 'HTTPS 代理地址', ALL_PROXY: '通用代理地址', NO_PROXY: '绕过代理的主机，逗号分隔',
  http_proxy: 'HTTP 代理地址（小写）', https_proxy: 'HTTPS 代理地址（小写）', all_proxy: '通用代理地址（小写）', no_proxy: '绕过代理的主机（小写）',
  DSH_TELEMETRY_DISABLED: '1 = 禁用，留空 = 使用默认',
}
const TOOLS = [{ value: 'bundles', label: '组合层' }, { value: 'patch', label: 'YAML 补丁' }, { value: 'environment', label: '环境变量' }]
const toEntries = (environment) => Object.entries(environment || {}).map(([key, value]) => ({ key, value: String(value) }))

export function SettingsProfileEditor({ profile, controller, onSaved, onDirtyChange }) {
  const [tool, setTool] = useState('bundles')
  const [bundles, setBundles] = useState('')
  const [patch, setPatch] = useState('')
  const [environment, setEnvironment] = useState([])
  const [revealed, setRevealed] = useState({})
  const [patchOpen, setPatchOpen] = useState(false)
  const [newKey, setNewKey] = useState('DEEPSEEK_API_KEY')
  const [validation, setValidation] = useState('')
  const id = useId()
  const blocked = Boolean(controller.pending) || profile.reserved === true

  useEffect(() => {
    setBundles((profile.bundles || []).join('\n'))
    setPatch(profile.patch || '')
    setEnvironment(toEntries(profile.environment))
    setRevealed({})
    setPatchOpen(false)
    setTool('bundles')
    setValidation('')
  }, [profile])

  const stableEnvironment = (value) => JSON.stringify(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)))
  const initialEnvironment = stableEnvironment(profile.environment)
  const parsedBundles = bundles.split('\n').map((line) => line.trim()).filter(Boolean)
  const environmentMap = Object.fromEntries(environment.map((entry) => [entry.key, entry.value]))
  const dirty = JSON.stringify(parsedBundles) !== JSON.stringify(profile.bundles || []) || patch !== (profile.patch || '') || stableEnvironment(environmentMap) !== initialEnvironment
  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const save = (event) => {
    event.preventDefault()
    setValidation('')
    if (!parsedBundles.length) return setValidation('组合层至少需要一项。每行填写一个 bundle，顺序会影响合并结果。')
    if (new Set(parsedBundles).size !== parsedBundles.length) return setValidation('组合层中有重复项，请移除重复行。')
    if (environment.some((entry) => !ENVIRONMENT_KEYS.includes(entry.key))) return setValidation('存在宿主不支持的环境变量，请移除后再保存。')
    if (environment.some((entry) => entry.value.includes('\u0000') || entry.value.includes('\n') || entry.value.includes('\r'))) return setValidation('环境变量须为单行文本，不能包含换行或空字符。')
    if (environmentMap.DSH_TELEMETRY_DISABLED != null && !['', '1'].includes(environmentMap.DSH_TELEMETRY_DISABLED)) return setValidation('DSH_TELEMETRY_DISABLED 仅支持 1（禁用）或留空（使用默认）。')
    const baseUrl = environmentMap.DEEPSEEK_BASE_URL
    if (baseUrl) {
      try {
        const url = new URL(baseUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('invalid')
      } catch {
        return setValidation('DEEPSEEK_BASE_URL 必须是 http(s) 地址，且不能包含账号、密码、查询参数或片段。')
      }
    }
    controller.ask({
      title: `保存 ${profile.name} 并停止进程？`,
      description: '宿主会先备份此 Profile，再保存组合层、YAML 补丁与环境覆盖，并停止 Web 与 SDK。正在进行的对话可能中断。',
      detail: `profiles/${profile.name}；环境变量仅用于此 Profile 的子进程。`,
      label: '备份并保存', operation: '保存 Profile',
      task: async () => {
        await controller.call('profiles.update', { name: profile.name, bundles: parsedBundles, patch, environment: environmentMap })
        await controller.refreshHost({ settings: true })
        await controller.requireLoad(controller.loadProfiles())
        await controller.requireLoad(controller.loadBackups())
        await onSaved(profile.name)
      },
      success: 'Profile 已备份并保存。Web 与 SDK 已停止，请按需手动启动。',
    })
  }
  const availableKeys = ENVIRONMENT_KEYS.filter((key) => !environment.some((entry) => entry.key === key))
  const addKey = availableKeys.includes(newKey) ? newKey : availableKeys[0]

  return (
    <Panel
      title={profile.name}
      description={profile.exists === false ? '模板尚未初始化。保存后由宿主创建实际 Profile。' : '配置来源为实际 Profile 文件；环境变量是 eNest 单独管理的子进程覆盖。'}
      className="dsh-settings-profile-editor"
      actions={profile.reserved ? <span className="dsh-settings-badge">保留 Profile，只读</span> : <span className="dsh-settings-badge">{dirty ? '未保存' : '已读取'}</span>}
    >
      <form className="dsh-settings-form" onSubmit={save}>
        <div className="dsh-settings-editor-navigation">
          <Segmented value={tool} options={TOOLS} onChange={setTool} ariaLabel="Profile 编辑内容" disabled={Boolean(controller.pending)} />
        </div>
        {tool === 'bundles' && (
          <div className="dsh-settings-editor-section">
            <Field label="Bundles 有序栈" htmlFor={`${id}-bundles`} hint="每行一个 bundle。由上到下合并，后面的层可覆盖前面的配置。宿主会校验组合能否用于所选运行角色。">
              <textarea id={`${id}-bundles`} className="dsh-settings-code-input" rows={7} spellCheck={false} value={bundles} disabled={blocked} onChange={(event) => setBundles(event.target.value)} />
            </Field>
            <div className="dsh-settings-note">
              <h4>依赖插件</h4>
              {Object.keys(profile.dependencies || {}).length ? (
                <dl className="dsh-settings-dependencies">{Object.entries(profile.dependencies).map(([name, version]) => <div key={name}><dt>{name}</dt><dd>{String(version)}</dd></div>)}</dl>
              ) : <p>此 Profile 没有声明额外依赖。</p>}
              <p>这里展示 package.json 的依赖信息，不在管理中心安装或执行插件。</p>
            </div>
          </div>
        )}
        {tool === 'patch' && (
          <div className="dsh-settings-editor-section">
            <Field label="cordis.patch.yml" htmlFor={patchOpen ? `${id}-patch` : undefined} hint="补丁会覆盖组合层配置。这里是原始 YAML，可能含有凭据；提交前请自行检查内容。">
              {patchOpen ? <textarea id={`${id}-patch`} className="dsh-settings-code-input dsh-settings-patch-input" rows={14} spellCheck={false} value={patch} disabled={blocked} onChange={(event) => setPatch(event.target.value)} /> : (
                <div className="dsh-settings-private-content">
                  <strong>{patch ? `补丁已隐藏（${patch.split('\n').length} 行）` : '尚无 YAML 补丁'}</strong>
                  <p>原始内容只在你主动打开后显示，避免在共享屏幕时暴露敏感配置。</p>
                  <Button disabled={Boolean(controller.pending)} onClick={() => setPatchOpen(true)}>{patch ? '查看并编辑补丁' : '编写补丁'}</Button>
                </div>
              )}
            </Field>
            {patchOpen && <Button variant="ghost" disabled={Boolean(controller.pending)} onClick={() => setPatchOpen(false)}>隐藏补丁内容</Button>}
          </div>
        )}
        {tool === 'environment' && (
          <div className="dsh-settings-editor-section">
            <div className="dsh-settings-heading-copy">
              <h4>环境变量（仅当前 Profile 的子进程）</h4>
              <p>这是 eNest 管理的环境覆盖，不是 DSH 的 .env 文件。只支持模型凭据、DeepSeek 地址、代理与遥测开关；其他 provider 地址请在 Models 或补丁中配置。</p>
            </div>
            {!environment.length && <p className="dsh-settings-help">未设置独立覆盖，子进程沿用宿主环境。</p>}
            <div className="dsh-settings-environment-list">
              {environment.map((entry, index) => (
                <div className="dsh-settings-environment-entry" key={entry.key}>
                  <Field label={entry.key} htmlFor={`${id}-env-${index}`} hint={ENVIRONMENT_HELP[entry.key] || '此键不在允许范围内，保存前请移除。'}>
                    <div className="dsh-settings-secret-row">
                      <Input
                        id={`${id}-env-${index}`} type={revealed[entry.key] ? 'text' : 'password'} value={entry.value}
                        autoComplete="off" spellCheck={false} disabled={blocked} aria-label={`${entry.key} 值`}
                        onChange={(event) => setEnvironment((current) => current.map((item) => item.key === entry.key ? { ...item, value: event.target.value } : item))}
                      />
                      <Button variant="ghost" disabled={Boolean(controller.pending)} aria-pressed={Boolean(revealed[entry.key])} onClick={() => setRevealed((current) => ({ ...current, [entry.key]: !current[entry.key] }))}>{revealed[entry.key] ? '隐藏' : '显示'}</Button>
                      <Button variant="ghost" disabled={blocked} onClick={() => setEnvironment((current) => current.filter((item) => item.key !== entry.key))}>移除</Button>
                    </div>
                  </Field>
                </div>
              ))}
            </div>
            {availableKeys.length > 0 && <div className="dsh-settings-add-environment">
              <Field label="添加受支持的变量"><Select ariaLabel="待添加的环境变量" value={addKey} options={availableKeys.map((key) => ({ value: key, label: key }))} onChange={setNewKey} disabled={blocked} /></Field>
              <Button disabled={blocked} onClick={() => setEnvironment((current) => [...current, { key: addKey, value: '' }])}>添加变量</Button>
            </div>}
            <p className="dsh-settings-help">移除变量表示不再覆盖该键，不会清除宿主环境中的值。备份可能包含凭据，仅保存在本机。</p>
          </div>
        )}
        <InlineMessage>{validation}</InlineMessage>
        <div className="dsh-settings-form-footer">
          <span>{dirty ? '更改尚未应用' : '修改后备份并保存'}</span>
          <Button type="submit" variant="primary" disabled={blocked || !dirty}>备份并保存</Button>
        </div>
      </form>
    </Panel>
  )
}
