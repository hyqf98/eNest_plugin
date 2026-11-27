/**
 * 配置要求：站点把最低 / 推荐配置写成一段 JSON 文本，后端已解析成键值对（DetailData.configSpec）。
 * 解析成功时渲染成对照表（同一行左最低、右推荐，按字段名对齐）；站点给的是纯文本时
 * （configSpec 为空）退回原来的两段文本，不做任何猜测。
 */

import type { ConfigField, ConfigSpec } from '../../shared/contracts'

/** 两组字段按出现顺序合并成一个有序的行标题列表；最低与推荐的键不完全相同时取并集 */
export function configRows(spec: ConfigSpec): string[] {
  const labels: string[] = []
  for (const field of [...spec.min, ...spec.recommend]) {
    if (!labels.includes(field.label)) labels.push(field.label)
  }
  return labels
}

function pick(fields: ConfigField[], label: string): string {
  return fields.find(field => field.label === label)?.value ?? ''
}

export function ConfigSection({ spec, minConfig, recommendConfig }: {
  spec: ConfigSpec
  minConfig: string
  recommendConfig: string
}) {
  const structured = spec.min.length > 0 || spec.recommend.length > 0
  const rows = structured ? configRows(spec) : []
  return (
    <section className="gh-panel">
      <h3>配置要求</h3>
      {rows.length ? (
        <table className="gh-detail-table gh-config-table">
          <thead>
            <tr><th scope="col">项目</th><th scope="col">最低配置</th><th scope="col">推荐配置</th></tr>
          </thead>
          <tbody>
            {rows.map(label => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{pick(spec.min, label) || '—'}</td>
                <td>{pick(spec.recommend, label) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <dl className="gh-detail-config">
          {minConfig ? <div><dt>最低配置</dt><dd>{minConfig}</dd></div> : null}
          {recommendConfig ? <div><dt>推荐配置</dt><dd>{recommendConfig}</dd></div> : null}
        </dl>
      )}
    </section>
  )
}
