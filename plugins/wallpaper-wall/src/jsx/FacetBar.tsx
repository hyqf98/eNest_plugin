import type { SourceFacet, SourceFacets, SourceFilterValue } from '../shared/contracts'
import type { I18nKey } from '../i18n'
import { Button, Select, Slider, Switch } from '../ui'
import { Icon } from './common'

interface FacetBarProps {
  facets: SourceFacets
  values: Record<string, SourceFilterValue>
  t: (key: I18nKey) => string
  onChange: (key: string, value: SourceFilterValue) => void
  onReset: () => void
}

export function defaultFilters(facets: SourceFacets): Record<string, SourceFilterValue> {
  const result: Record<string, SourceFilterValue> = {}
  for (const facet of facets.items) {
    if (facet.default !== undefined) {
      const value = facet.default
      result[facet.key] = (facet.type === 'select' || facet.type === 'sort') && typeof value === 'number' ? String(value) : value as SourceFilterValue
    }
    else if (facet.type === 'multi' || facet.type === 'tags') result[facet.key] = []
    else if (facet.type === 'toggle') result[facet.key] = false
    else if (facet.type === 'range') result[facet.key] = facet.min ?? 0
    else result[facet.key] = ''
  }
  return result
}

export function FacetBar({ facets, values, t, onChange, onReset }: FacetBarProps) {
  if (!facets.items.length) return null
  return (
    <div className="wh-facets" role="group" aria-label={t('label.filters')}>
      <span className="wh-facets-label"><Icon name="settings" size={13} />{t('label.filters')}</span>
      {facets.items.map(facet => (
        <FacetControl key={facet.key} facet={facet} value={values[facet.key]} t={t} onChange={value => onChange(facet.key, value)} />
      ))}
      <Button className="wh-facets-reset" size="sm" variant="ghost" onClick={onReset} aria-label={t('action.resetFilters')}><Icon name="refresh" />{t('action.resetFilters')}</Button>
    </div>
  )
}

function FacetControl({ facet, value, t, onChange }: { facet: SourceFacet; value: SourceFilterValue | undefined; t: (key: I18nKey) => string; onChange: (value: SourceFilterValue) => void }) {
  if (facet.type === 'select' || facet.type === 'sort') {
    const options = facet.options ?? []
    // Size to the longest option of this facet (about 12px per CJK glyph / 7px per latin char) instead of
    // a flat minimum, so a source with many facets still fits on one row.
    const longest = options.reduce((width, option) => Math.max(width, [...String(option.label)].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e7f ? 12 : 7), 0)), 0)
    return (
      <label className="wh-facet wh-facet-select">
        <span>{facet.label}</span>
        <Select
          value={typeof value === 'string' ? value : ''}
          options={options}
          onChange={onChange}
          ariaLabel={facet.label}
          minWidth={Math.min(72, longest) + 22}
        />
      </label>
    )
  }
  if (facet.type === 'multi' || facet.type === 'tags') {
    const selected = Array.isArray(value) ? value : []
    return (
      <div className="wh-facet wh-facet-chips" role="group" aria-label={facet.label}>
        <span>{facet.label}</span>
        <div className="wh-chips">
          {(facet.options ?? []).map(option => {
            const active = selected.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                className={`wh-chip${active ? ' active' : ''}`}
                aria-pressed={active}
                onClick={() => onChange(active ? selected.filter(entry => entry !== option.value) : [...selected, option.value])}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    )
  }
  if (facet.type === 'toggle') {
    return (
      <label className="wh-facet wh-facet-toggle">
        <span>{facet.label}</span>
        <Switch checked={value === true} onCheckedChange={checked => onChange(checked)} aria-label={facet.label} />
      </label>
    )
  }
  if (facet.type === 'range') {
    const number = typeof value === 'number' ? value : facet.min ?? 0
    return (
      <label className="wh-facet wh-facet-range">
        <span>{facet.label}<b>{number}</b></span>
        <Slider
          value={[number]}
          min={facet.min ?? 0}
          max={facet.max ?? 100}
          step={facet.step ?? 1}
          onValueChange={next => onChange(next[0] ?? facet.min ?? 0)}
          aria-label={facet.label}
        />
      </label>
    )
  }
  if (facet.type === 'color') {
    const selected = typeof value === 'string' ? value.toLowerCase() : ''
    return (
      <div className="wh-facet wh-facet-color" role="group" aria-label={facet.label}>
        <span>{facet.label}</span>
        <div className="wh-colors">
          <button type="button" className={`wh-color${!selected ? ' active' : ''}`} aria-label={t('label.all')} aria-pressed={!selected} onClick={() => onChange('')} />
          {(facet.values ?? []).map(color => (
            <button
              key={color}
              type="button"
              className={`wh-color${selected === color.toLowerCase() ? ' active' : ''}`}
              style={{ background: color, borderColor: color }}
              aria-label={color}
              aria-pressed={selected === color.toLowerCase()}
              onClick={() => onChange(selected === color.toLowerCase() ? '' : color)}
            />
          ))}
        </div>
      </div>
    )
  }
  return null
}
