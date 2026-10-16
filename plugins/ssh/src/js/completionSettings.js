const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

/** Opt-in remote facts use separate read-only channels; candidates never submit commands. */
export function renderCompletionSettings(container, { store, toast, integrate, connected, shortcuts }) {
  const prefs = { enabled: true, autoSuggest: true, commands: true, options: true, snippets: true, history: true, remotePaths: true, remoteCommands: false, minChars: 1, maxItems: 8, ...store.state.ui.completion }
  const commands = Array.isArray(prefs.userCommands) ? prefs.userCommands.map(item => ({ ...item })) : []
  container.innerHTML = `<h2>命令提示</h2><p>提示显示在终端光标下方，只有确认处于空闲 Bash / Zsh 提示符时才出现。选中候选只补上尚未输入的部分，按 Enter 后由远端 shell 执行。</p><form class="wb-settings-form wb-completion-settings"><div class="wb-settings-checks">${[['enabled','启用命令提示'],['autoSuggest','输入时自动联想'],['commands','常见命令'],['options','命令选项'],['snippets','常用命令片段'],['history','当前连接的命令历史']].map(([name,label]) => `<label><input type="checkbox" name="${name}" ${prefs[name] !== false ? 'checked' : ''}>${label}</label>`).join('')}</div><label>开始联想的字符数<input type="number" name="minChars" min="1" max="8" value="${Number(prefs.minChars) || 1}"></label><label>候选行数<input type="number" name="maxItems" min="4" max="12" value="${Number(prefs.maxItems) || 8}"></label><div class="wb-completion-keys"><span><kbd>Mod ⇧ Space</kbd> 打开提示</span><span><kbd>Alt ↑ / ↓</kbd> 选择</span><span><kbd>Alt Enter</kbd> 填入</span><span><kbd>Esc</kbd> 收起</span></div><small>Tab、Enter、方向键继续交给远端终端。服务器原生 Tab 路径补全保持可用；全屏程序、密码输入和不确定的命令状态不会产生本地候选。</small><h3>自定义命令</h3><p>添加常用命令与说明。单条命令不包含换行或控制字符；只作为候选显示，不会自动执行。</p><div class="wb-custom-commands"></div><button type="button" class="wb-add-command" data-add-command>＋ 添加命令</button><span class="wb-settings-feedback" role="status" aria-live="polite"></span><button type="submit">保存命令提示设置</button></form>`
  const form = container.querySelector('form'), list = container.querySelector('.wb-custom-commands'), feedback = form.querySelector('[role="status"]')
  const remoteOptions = document.createElement('section'); remoteOptions.className = 'wb-remote-completion-settings'
  remoteOptions.innerHTML = `<h3>远端动态提示</h3><div class="wb-settings-checks">${[['remotePaths','读取远端路径（SFTP）'],['remoteCommands','开启可用命令检查（远端 PATH）']].map(([name,label]) => `<label><input type="checkbox" name="${name}" ${prefs[name] === true ? 'checked' : ''}>${label}</label>`).join('')}</div><small>路径默认开启，可用命令检查默认关闭。仅在可信空闲提示符读取，候选注明来源；读取通过独立通道，不向终端写入命令。目录缓存 3 秒，PATH 缓存 60 秒。PATH 来自独立 exec 会话，可能与终端中临时修改的 PATH 不同，不包含临时别名或函数。</small>`
  form.querySelector('.wb-settings-checks').after(remoteOptions)
  const sessionButton = document.createElement('button'); sessionButton.type = 'button'; sessionButton.className = 'wb-enable-session-hints'; sessionButton.textContent = '启用本次会话提示'; sessionButton.disabled = !connected?.(); sessionButton.dataset.enableSessionHints = ''
  container.querySelector('p').after(sessionButton)
  sessionButton.onclick = async () => { try { await integrate?.() } catch (error) { feedback.textContent = error.message } }
  const keys = shortcuts?.()
  if (keys) form.querySelector('.wb-completion-keys').innerHTML = `<span><kbd>${escape(keys.trigger || '命令菜单')}</kbd> 打开提示</span><span><kbd>${escape(keys.previous || '点击')} / ${escape(keys.next || '悬停')}</kbd> 选择</span><span><kbd>${escape(keys.accept || '点击')}</kbd> 填入</span><span><kbd>Esc</kbd> 收起</span>`
  form.querySelector('.wb-completion-keys').insertAdjacentHTML('afterend', '<small>Enter 执行当前命令；↑ / ↓ 切换远端历史。选中终端里的单行命令后，可从工具栏或右键菜单填入／执行；在快捷键页可修改这些操作的组合键。</small>')
  function renderRows() {
    list.innerHTML = commands.length ? commands.map((item, index) => `<div class="wb-custom-command" data-command-row="${index}"><input data-command-field="command" value="${escape(item.command)}" placeholder="例如 kubectl get pods" aria-label="自定义命令 ${index + 1}" spellcheck="false"><input data-command-field="description" value="${escape(item.description)}" placeholder="用途说明" aria-label="命令说明 ${index + 1}"><button type="button" data-remove-command="${index}" aria-label="删除命令 ${index + 1}">×</button></div>`).join('') : '<span class="wb-command-empty">尚未添加，内置命令和常用片段仍可使用。</span>'
    list.querySelectorAll('[data-command-field]').forEach(input => input.oninput = () => { commands[Number(input.closest('[data-command-row]').dataset.commandRow)][input.dataset.commandField] = input.value; feedback.textContent = '' })
    list.querySelectorAll('[data-remove-command]').forEach(button => button.onclick = () => { commands.splice(Number(button.dataset.removeCommand), 1); renderRows() })
  }
  form.querySelector('[data-add-command]').onclick = () => { commands.push({ command: '', description: '' }); renderRows(); list.querySelector('[data-command-row]:last-child input')?.focus() }
  form.onsubmit = async event => {
    event.preventDefault()
    const invalid = commands.findIndex(item => !item.command?.trim() || /[\x00-\x1f\x7f-\x9f]/.test(item.command))
    if (invalid >= 0) { feedback.textContent = '请填写单行命令，不能包含换行或控制字符。'; list.querySelector(`[data-command-row="${invalid}"] input`)?.focus(); return }
    const next = { ...prefs, userCommands: commands.map(item => ({ command: item.command.trim(), description: String(item.description || '').trim() })), minChars: Math.min(8, Math.max(1, Number(form.elements.minChars.value) || 1)), maxItems: Math.min(12, Math.max(4, Number(form.elements.maxItems.value) || 8)) }
    for (const name of ['enabled','autoSuggest','commands','options','snippets','history','remotePaths','remoteCommands']) next[name] = form.elements[name].checked
    const saved = await store.setUi({ completion: next }, true)
    window.dispatchEvent(new Event('ssh-completion-settings-change'))
    feedback.textContent = saved === false ? '保存失败，当前输入已保留，可重试。' : '命令提示设置已保存，当前会话立即生效。'
    if (saved !== false) toast('命令提示设置已保存')
  }
  renderRows()
}
