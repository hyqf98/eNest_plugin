import { DEFAULT_CONFIG } from '@db/sql-intelligence/configuration/index.js'
import { esc, field, select } from './formMarkup.js'

/** Presentation only: state changes and persistence belong to completionSettings. */
export function settingsMarkup(draft, { initialIssue, canClearUsage }) {
  return `
    <div class="sql-section-heading">
      <div>
        <h2>SQL 智能提示</h2>
        <p class="muted">按查询上下文提示字段、关系和模板。设置保存在本机，连接和方言可单独覆盖。</p>
      </div>
      <button class="btn primary" data-save-completion>保存智能提示设置</button>
    </div>
    <p class="sql-save-state" data-save-state role="status" aria-live="polite">${esc(initialIssue || '修改后保存生效。试验区即时使用当前草稿。')}</p>
    ${behaviorSection(draft, canClearUsage)}
    ${diagnosticsSection(draft)}
    <section class="sql-config-section" data-column-sets></section>
    <section class="sql-config-section" data-query-templates></section>
    <section class="sql-config-section" data-custom-functions></section>
    <section class="sql-config-section" data-static-enums></section>
    <section class="sql-config-section" data-scoped-profiles></section>
    <section class="sql-config-section" data-completion-playground></section>
    ${metadataSection(draft)}
    ${advancedSection(draft)}
  `
}

function behaviorSection(draft, canClearUsage) {
  const behavior = { ...DEFAULT_CONFIG.behavior, ...draft.behavior }
  const ranking = { ...DEFAULT_CONFIG.ranking, ...draft.ranking }
  return `
    <section class="sql-config-section">
      <h3>补全行为</h3>
      <div class="sql-check-grid">
        ${field('输入时自动提示', 'behavior.automatic', behavior.automatic, 'checkbox')}
        ${field('Enter 接受候选', 'behavior.acceptOnEnter', behavior.acceptOnEnter, 'checkbox')}
        ${field('Tab 接受候选', 'behavior.acceptOnTab', behavior.acceptOnTab, 'checkbox')}
        ${field('表名补全附加别名', 'behavior.autoAlias', behavior.autoAlias, 'checkbox')}
        ${field('按使用频率排序', 'behavior.learnUsage', behavior.learnUsage, 'checkbox')}
        ${field('搜索字段备注', 'behavior.commentSearch', behavior.commentSearch, 'checkbox')}
      </div>
      <div class="sql-form-grid">
        ${field('提示延迟（毫秒）', 'behavior.delayMs', behavior.delayMs, 'number', 'min="0" max="2000" step="10"')}
        ${field('最少输入字符', 'behavior.minPrefixLength', behavior.minPrefixLength, 'number', 'min="0" max="8"')}
        ${select('关键词大小写', 'behavior.keywordCase', behavior.keywordCase, [['upper', '大写'], ['lower', '小写'], ['preserve', '保持原样']])}
        ${select('星号展开', 'behavior.starExpansion', behavior.starExpansion, [['suggest', '显示展开建议'], ['off', '关闭展开建议']])}
        ${field('最多候选数', 'behavior.maxItems', behavior.maxItems, 'number', 'min="10" max="500"')}
        ${field('使用频率权重', 'ranking.usageWeight', ranking.usageWeight, 'number', 'min="0" max="20"')}
      </div>
      <p class="muted">星号只在接受候选后展开。COUNT(*) 保持原样；点号后的字段提示不受最小字符数限制。</p>
      ${canClearUsage ? '<button class="btn" data-clear-completion-usage>清除补全学习记录</button>' : ''}
    </section>
  `
}

function diagnosticsSection(draft) {
  const diagnostics = { ...DEFAULT_CONFIG.diagnostics, ...draft.diagnostics }
  return `
    <section class="sql-config-section">
      <h3>SQL 提醒</h3>
      <div class="sql-form-grid">
        ${select('SELECT *', 'diagnostics.selectStar', diagnostics.selectStar, levels())}
        ${select('重复别名', 'diagnostics.duplicateAlias', diagnostics.duplicateAlias, levels(true))}
        ${select('无法确认的字段', 'diagnostics.unknownColumn', diagnostics.unknownColumn, levels())}
        ${select('无条件 UPDATE / DELETE', 'diagnostics.unsafeMutation', diagnostics.unsafeMutation, levels())}
      </div>
      <p class="muted">提醒不执行 SQL，也不改变已有的执行确认和事务行为。</p>
    </section>
  `
}

function metadataSection(draft) {
  const metadata = { ...DEFAULT_CONFIG.metadata, ...draft.metadata }
  return `
    <details class="sql-config-section">
      <summary>元数据缓存</summary>
      <div class="sql-form-grid">
        ${field('缓存有效期（毫秒）', 'metadata.ttlMs', metadata.ttlMs, 'number', 'min="1000" max="86400000"')}
        ${field('缓存对象上限', 'metadata.maxObjects', metadata.maxObjects, 'number', 'min="10" max="10000"')}
        ${select('预取范围', 'metadata.prefetch', metadata.prefetch, [['referenced', '当前 SQL 引用的表'], ['none', '按需读取']])}
      </div>
      <p class="muted">只读取对象结构，不读取业务行数据。预取范围用于补全，读取失败时保留可用的本地候选。</p>
    </details>
  `
}

function advancedSection(draft) {
  return `
    <details class="sql-config-section">
      <summary>自定义函数、枚举和高级配置</summary>
      <p class="muted">函数、枚举与局部规则可在上方直接编辑。此处保留完整 JSON、导入导出和更细的覆盖项；可视化编辑会保留未修改的高级选项。所有内容都是声明式数据，不运行 JavaScript。</p>
      <textarea class="sql-config-json" data-completion-json rows="16" aria-label="SQL 智能提示 JSON 配置" spellcheck="false">${esc(JSON.stringify(draft, null, 2))}</textarea>
      <div class="sql-inline-actions">
        <button class="btn" data-apply-completion-json>校验并应用到草稿</button>
        <button class="btn" data-export-completion>导出配置</button>
        <button class="btn" data-import-completion>导入配置</button>
        <button class="btn" data-reset-completion>恢复默认草稿</button>
      </div>
      <input type="file" data-import-file accept="application/json,.json" hidden>
      <p class="sql-config-issues" data-json-issues role="status"></p>
      <div data-import-preview hidden></div>
    </details>
  `
}

function levels(includeError = false) {
  return [['off', '关闭'], ['hint', '提示'], ['warning', '警告'], ...(includeError ? [['error', '错误']] : [])]
}
