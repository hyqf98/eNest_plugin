/** 左栏：环境家族分组（多实例缩进）+ 包管理器分组 + 自定义路径管理。 */
import { useMemo } from 'react'
import { Button } from '../ui/index.jsx'
import { formatBytes } from '../js/format.js'
import { familyIcon } from './icons.jsx'

const FAMILY_ORDER = ['node', 'python', 'uv', 'conda', 'java', 'maven', 'gradle', 'go', 'rust']

export function EnvList({ snapshot, selected, onSelect, search, customEnvs, onRemoveCustom, onAddCustom }) {
  const query = (search ?? '').trim().toLowerCase()
  const matches = (...values) => !query || values.some(value => String(value ?? '').toLowerCase().includes(query))

  const families = useMemo(() => {
    if (!snapshot) return []
    return [...snapshot.families].sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family))
  }, [snapshot])

  const managers = useMemo(() => (snapshot?.packageManagers ?? []).filter(pm => pm.available), [snapshot])

  const selectionEquals = (candidate) => {
    if (!selected) return false
    return candidate.kind === selected.kind && candidate.family === selected.family && candidate.id === selected.id && candidate.pm === selected.pm
  }

  return (
    <aside className="sidebar" aria-label="环境列表">
      <div className="sidebar-scroll">
        {families.map(family => {
          const instances = family.instances.filter(instance => matches(instance.label, instance.version, instance.family))
          const familyHit = matches(family.label, family.family)
          if (!familyHit && instances.length === 0) return null
          return (
            <div key={family.family} className="family-group">
              <div className={'family-head' + (family.installed ? '' : ' off')}>{family.label}{!family.installed ? ' ·未装' : ''}</div>
              {(familyHit && instances.length === 0 && family.instances.length > 0 ? family.instances : instances).map(instance => (
                <button
                  key={instance.id}
                  type="button"
                  className={'env-row' + (instance.note && /nvm|fnm|volta|pyenv|sdkman|toolchain|conda 环境/.test(instance.note ?? '') ? ' nested' : '') + (selectionEquals({ kind: 'family', family: family.family, id: instance.id }) ? ' active' : '')}
                  onClick={() => onSelect({ kind: 'family', family: family.family, id: instance.id })}
                >
                  <span className="env-icon">{familyIcon(family.family)}</span>
                  <span className="env-name">{instance.label}</span>
                  {instance.version && <span className="badge">{instance.version.replace(/^v?(?:go )?/, '').split(' ')[0].slice(0, 14)}</span>}
                  <span className="env-remove" hidden={!instance.id.includes(':custom:') || !customEnvs.some(custom => instance.id.endsWith(`:${custom.id}`))}
                    role="button" tabIndex={0}
                    onClick={(event) => { event.stopPropagation(); const hit = customEnvs.find(custom => instance.id.endsWith(`:${custom.id}`)); if (hit) onRemoveCustom(hit.id) }}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click() } }}
                    title="移除自定义路径">×</span>
                </button>
              ))}
            </div>
          )
        })}

        {managers.length > 0 && (
          <div className="family-group">
            <div className="family-head">包管理器</div>
            {managers.map(pm => (
              <button key={pm.id} type="button"
                className={'env-row' + (selectionEquals({ kind: 'pm', pm: pm.id }) ? ' active' : '')}
                onClick={() => onSelect({ kind: 'pm', pm: pm.id })}>
                <span className="env-icon">{familyIcon(pm.id)}</span>
                <span className="env-name">{pm.label}</span>
                {pm.prefix && <span className="badge mono-badge" title={pm.prefix}>{pm.prefix.split('/').pop()}</span>}
              </button>
            ))}
          </div>
        )}

        {customEnvs.length > 0 && (
          <div className="family-group">
            <div className="family-head">自定义路径</div>
            {customEnvs.map(custom => (
              <div key={custom.id} className="custom-row" title={custom.rootPath}>
                <span className="env-icon">{familyIcon(custom.family)}</span>
                <span className="env-name">{custom.label}</span>
                <span className="env-remove" role="button" tabIndex={0}
                  onClick={() => onRemoveCustom(custom.id)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRemoveCustom(custom.id) } }}
                  title="移除">×</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="add-env" onClick={onAddCustom}>+ 添加路径</button>
    </aside>
  )
}
