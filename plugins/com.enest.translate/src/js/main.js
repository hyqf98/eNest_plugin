;(() => {
  const api = window.enest || window.zapi,
    $ = (id) => document.getElementById(id),
    esc = PluginKit.escape,
    LANGS = {
      auto: '自动检测',
      'zh-CN': '中文',
      en: '英语',
      ja: '日语',
      ko: '韩语',
      fr: '法语',
      de: '德语',
      es: '西班牙语',
      ru: '俄语',
    },
    KEY = 'translate_history_v2'
  let history = [],
    result = null,
    detected = '',
    request = 0,
    timer,
    historyFilter = 'all',
    historyQuery = '',
    loaded = false,
    preferenceQueue = Promise.resolve()
  const kit = PluginKit.create({
    title: '翻译',
    quickPlaceholder: '输入要翻译的文字 · Enter 翻译',
    height: 510,
    defaults: {
      srcLang: 'auto',
      tgtLang: 'zh-CN',
      engine: 'auto',
      autoTranslate: false,
      resultFontSize: 18,
    },
    onQuery: (value) => {
      $('input').value = String(value).slice(0, 10000)
      inputChanged(false)
    },
    onAction: (action) => {
      if (action === 'submit') void run()
      if (action === 'clear') clear()
    },
  })
  $('src').innerHTML = Object.entries(LANGS)
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join('')
  $('tgt').innerHTML = Object.entries(LANGS)
    .filter(([v]) => v !== 'auto')
    .map(([v, l]) => `<option value="${v}">${l}</option>`)
    .join('')
  function invalidate() {
    request++
    clearTimeout(timer)
    $('run').disabled = false
    $('run').textContent = '翻译'
    $('output').classList.remove('busy')
    $('output-state').hidden = true
    $('hint').textContent = '输入即翻译 · Enter 立即 · Shift+Enter 换行'
  }
  function sync() {
    const available = !!result
    for (const id of ['copy', 'copy-both', 'favorite', 'export-current'])
      $(id).disabled = !available
    $('favorite').textContent =
      result && history.find((h) => h.id === result.id)?.starred
        ? '★ 已收藏'
        : '☆ 收藏'
  }
  function clear() {
    invalidate()
    $('input').value = ''
    kit.setQuery('')
    result = null
    detected = ''
    $('counter').textContent = '0 / 10000'
    $('detected').textContent = ''
    $('engine-tag').textContent = ''
    $('output').textContent = '译文会显示在这里'
    $('output').className = 'placeholder'
    $('output-state').hidden = true
    sync()
  }
  function inputChanged(updateHost = true) {
    invalidate()
    detected = ''
    result = null
    $('output').textContent = '原文已更新，正在翻译'
    $('output').className = 'placeholder'
    $('engine-tag').textContent = ''
    $('detected').textContent = ''
    $('counter').textContent = $('input').value.length + ' / 10000'
    sync()
    if (updateHost) kit.setQuery($('input').value)
    // 即时翻译：停 350ms 自动联网翻译（防抖；autoTranslate 设置为暂停开关）
    if (!kit.settings.autoTranslate && $('input').value.trim()) timer = setTimeout(() => void run(), 350)
  }
  async function saveHistory() {
    if (!loaded) return
    try {
      await kit.save(KEY, { version: 2, history })
    } catch (e) {
      kit.toast('历史保存失败：' + e.message, 'error')
    }
  }
  function renderHistory() {
    const rows = history.filter(
      (h) =>
        (historyFilter !== 'starred' || h.starred) &&
        `${h.source} ${h.text}`
          .toLowerCase()
          .includes(historyQuery.toLowerCase()),
    )
    $('history-list').innerHTML = rows.length
      ? rows
          .map(
            (h) =>
              `<article class="entry" data-id="${esc(h.id)}" tabindex="0"><div class="entry-source">${esc(h.source)}</div><div class="entry-result">${esc(h.text)}</div><div class="entry-meta"><span>${esc(LANGS[h.src] || h.src)} → ${esc(LANGS[h.tgt] || h.tgt)} · ${new Date(h.ts).toLocaleDateString()}</span><button data-star="${esc(h.id)}" aria-label="${h.starred ? '取消收藏' : '收藏'}">${h.starred ? '★' : '☆'}</button><button data-delete="${esc(h.id)}" aria-label="删除历史">×</button></div></article>`,
          )
          .join('')
      : '<div class="empty">还没有翻译记录<br>成功的译文会保存在本机</div>'
    document
      .querySelectorAll('[data-history]')
      .forEach((b) =>
        b.classList.toggle('active', b.dataset.history === historyFilter),
      )
  }
  async function fetchJSON(url, label) {
    if (!api?.net?.fetch) throw Error('网络接口不可用')
    const res = await api.net.fetch({ url, method: 'GET', timeoutMs: 10000 })
    if (res.status < 200 || res.status >= 300)
      throw Error(`${label} HTTP ${res.status}`)
    try {
      return JSON.parse(res.body)
    } catch {
      throw Error(`${label} 返回了无法解析的内容`)
    }
  }
  async function google(q, src, tgt) {
    const data = await fetchJSON(
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
        encodeURIComponent(src) +
        '&tl=' +
        encodeURIComponent(tgt) +
        '&dt=t&q=' +
        encodeURIComponent(q),
      'Google',
    )
    if (!Array.isArray(data?.[0])) throw Error('Google 响应格式异常')
    const text = data[0]
      .filter((s) => Array.isArray(s) && typeof s[0] === 'string')
      .map((s) => s[0])
      .join('')
    if (!text) throw Error('Google 没有返回译文')
    return {
      text,
      detected: typeof data[2] === 'string' ? data[2] : '',
      engine: 'google',
    }
  }
  async function mymemory(q, src, tgt) {
    if (src === 'auto') throw Error('MyMemory 需要手动选择源语言')
    if (new TextEncoder().encode(q).length > 500)
      throw Error('MyMemory 单次最多支持 500 字节，请缩短原文或选择 Google')
    const data = await fetchJSON(
      'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(q) +
        '&langpair=' +
        encodeURIComponent(src + '|' + tgt),
      'MyMemory',
    )
    const text = data?.responseData?.translatedText
    if (
      typeof text !== 'string' ||
      !text ||
      /^(MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID )/i.test(text)
    )
      throw Error(text || 'MyMemory 没有返回译文')
    return { text, detected: src, engine: 'mymemory' }
  }
  async function translate(q, src, tgt, engine) {
    if (engine === 'google') return google(q, src, tgt)
    if (engine === 'mymemory') return mymemory(q, src, tgt)
    try {
      return await google(q, src, tgt)
    } catch (e) {
      if (String(e.message).includes('permission denied')) throw e
      if (src === 'auto')
        throw Error('Google 暂时不可用。请选择源语言后，可使用 MyMemory 重试。')
      return mymemory(q, src, tgt)
    }
  }
  async function run() {
    await initialized
    clearTimeout(timer)
    const source = $('input').value.trim()
    if (!source) {
      clear()
      return
    }
    const src = $('src').value,
      tgt = $('tgt').value,
      engine = $('engine').value,
      id = ++request
    result = null
    sync()
    $('run').disabled = true
    $('run').textContent = '翻译中…'
    $('output').className = 'placeholder busy'
    $('output').textContent = ''
    $('output-state').hidden = false
    $('output-state-text').textContent =
      engine === 'mymemory' ? 'MyMemory 正在翻译…' : '正在获取译文…'
    $('engine-tag').textContent = ''
    try {
      const translated =
        src === tgt
          ? { text: source, detected: src, engine: 'local' }
          : await translate(source, src, tgt, engine)
      if (id !== request) return
      detected = translated.detected
      const previous = history.find(
        (h) => h.source === source && h.src === src && h.tgt === tgt,
      )
      result = {
        id: previous?.id || crypto.randomUUID(),
        source,
        text: translated.text,
        src,
        tgt,
        detected,
        engine: translated.engine,
        ts: Date.now(),
        starred: previous?.starred || false,
      }
      history = [result, ...history.filter((h) => h.id !== result.id)]
      let unstarred = 0
      history = history.filter((h) => h.starred || ++unstarred <= 300)
      $('output').className = ''
      $('output').textContent = result.text
      $('engine-tag').textContent = {
        google: 'Google',
        mymemory: 'MyMemory',
        local: '相同语言',
      }[result.engine]
      $('detected').textContent = detected
        ? '识别为 ' + (LANGS[detected] || detected)
        : ''
      void saveHistory()
      renderHistory()
    } catch (e) {
      if (id !== request) return
      result = null
      $('output').className = 'error'
      $('output').textContent = '翻译失败：' + e.message
      $('output-state').hidden = true
      $('hint').textContent = '调整语言或引擎后重试'
    } finally {
      if (id === request) {
        $('run').disabled = false
        $('run').textContent = '翻译'
        $('output').classList.remove('busy')
        $('output-state').hidden = true
        sync()
      }
    }
  }
  function savePrefs() {
    const prefs = {
      srcLang: $('src').value,
      tgtLang: $('tgt').value,
      engine: $('engine').value,
    }
    Object.assign(kit.settings, prefs)
    preferenceQueue = preferenceQueue
      .catch(() => {})
      .then(async () => {
        for (const [key, value] of Object.entries(prefs))
          await api.settings.set(key, value)
      })
      .catch((e) => kit.toast('偏好保存失败：' + e.message, 'error'))
  }
  function changeDirection({ rerun = true } = {}) {
    invalidate()
    result = null
    sync()
    PluginKit.upgradeSelects() // src/tgt 直接赋值后同步自定义下拉标签
    renderLangChips()
    savePrefs()
    if (rerun && $('input').value.trim()) void run()
  }
  $('input').oninput = () => inputChanged()
  $('input').onkeydown = (e) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.isComposing
    ) {
      e.preventDefault()
      void run()
    }
  }
  $('run').onclick = () => void run()
  $('clear').onclick = clear
  $('src').onchange = changeDirection
  $('tgt').onchange = changeDirection
  $('engine').onchange = changeDirection
  $('swap').onclick = () => {
    const src = $('src').value === 'auto' ? detected : $('src').value
    if (!src || !LANGS[src]) {
      kit.toast('先翻译一次以检测源语言')
      return
    }
    const oldTarget = $('tgt').value
    $('src').value = oldTarget
    $('tgt').value = src
    PluginKit.upgradeSelects() // 交换语言后同步自定义下拉标签
    if (result) {
      $('input').value = result.text
      kit.setQuery(result.text)
    }
    detected = ''
    changeDirection()
  }
  document.querySelectorAll('[data-lang]').forEach(
    (b) =>
      (b.onclick = () => {
        $('tgt').value = b.dataset.lang
        PluginKit.upgradeSelects() // chips 切换目标语言后同步下拉标签
        changeDirection()
      }),
  )
  // 目标语言快捷 chips 状态（当前目标语言高亮；原文即该语言时禁用）
  function renderLangChips() {
    const tgt = $('tgt').value,
      src = $('src').value
    document.querySelectorAll('[data-lang]').forEach((b) => {
      const lang = b.dataset.lang
      b.classList.toggle('active', lang === tgt)
      b.disabled = lang === src
      b.title = lang === src ? '与源语言相同' : `译为${LANGS[lang]}`
    })
  }
  $('paste').onclick = async () => {
    try {
      const text = await api.clipboard.readText()
      $('input').value = String(text || '').slice(0, 10000)
      inputChanged()
      $('input').focus()
    } catch (e) {
      kit.toast(e.message, 'error')
    }
  }
  const bilingual = () => (result ? result.source + '\n\n' + result.text : '')
  $('copy').onclick = () =>
    result && kit.copy(result.text).catch((e) => kit.toast(e.message, 'error'))
  $('copy-both').onclick = () =>
    result && kit.copy(bilingual()).catch((e) => kit.toast(e.message, 'error'))
  $('favorite').onclick = () => {
    if (!result) return
    const h = history.find((h) => h.id === result.id)
    if (h) {
      h.starred = !h.starred
      void saveHistory()
      renderHistory()
      sync()
    }
  }
  $('export-current').onclick = () =>
    kit
      .saveText('翻译结果.txt', bilingual())
      .catch((e) => kit.toast(e.message, 'error'))
  $('export-history').onclick = () =>
    kit
      .saveText(
        '翻译历史.json',
        JSON.stringify({ version: 2, history }, null, 2),
      )
      .catch((e) => kit.toast(e.message, 'error'))
  $('history-toggle').onclick = () => $('history').classList.toggle('open')
  $('quick-history').onclick = () => $('history').classList.add('open')
  $('close-history').onclick = () => $('history').classList.remove('open')
  $('history-search').oninput = (e) => {
    historyQuery = e.target.value
    renderHistory()
  }
  document.querySelectorAll('[data-history]').forEach(
    (b) =>
      (b.onclick = () => {
        historyFilter = b.dataset.history
        renderHistory()
      }),
  )
  function recall(id) {
    const h = history.find((h) => h.id === id)
    if (!h) return
    invalidate()
    result = h
    detected = h.detected || ''
    $('input').value = h.source
    kit.setQuery(h.source)
    $('src').value = h.src
    $('tgt').value = h.tgt
    PluginKit.upgradeSelects() // 回填历史语言后同步自定义下拉标签
    $('output').textContent = h.text
    $('output').className = ''
    $('engine-tag').textContent =
      h.engine === 'google'
        ? 'Google'
        : h.engine === 'mymemory'
          ? 'MyMemory'
          : '本地'
    $('detected').textContent = detected
      ? '识别为 ' + (LANGS[detected] || detected)
      : ''
    $('counter').textContent = h.source.length + ' / 10000'
    $('history').classList.remove('open')
    sync()
  }
  $('history-list').onclick = (e) => {
    const star = e.target.closest('[data-star]'),
      del = e.target.closest('[data-delete]')
    if (star) {
      const h = history.find((h) => h.id === star.dataset.star)
      h.starred = !h.starred
      void saveHistory()
      renderHistory()
      sync()
      return
    }
    if (del) {
      history = history.filter((h) => h.id !== del.dataset.delete)
      void saveHistory()
      renderHistory()
      sync()
      return
    }
    const row = e.target.closest('[data-id]')
    if (row) recall(row.dataset.id)
  }
  $('history-list').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const row = e.target.closest('[data-id]')
      if (row) recall(row.dataset.id)
    }
  }
  $('clear-history').onclick = () => {
    if (confirm('清空所有未收藏的翻译历史？')) {
      history = history.filter((h) => h.starred)
      void saveHistory()
      renderHistory()
      sync()
    }
  }
  function applyPrefs() {
    if (LANGS[kit.settings.srcLang]) $('src').value = kit.settings.srcLang
    if (kit.settings.tgtLang !== 'auto' && LANGS[kit.settings.tgtLang])
      $('tgt').value = kit.settings.tgtLang
    if (['auto', 'google', 'mymemory'].includes(kit.settings.engine))
      $('engine').value = kit.settings.engine
    PluginKit.upgradeSelects() // 设置驱动的语言/引擎赋值后同步下拉标签
    document.documentElement.style.setProperty(
      '--translation-font',
      Math.max(14, Math.min(24, Number(kit.settings.resultFontSize) || 18)) +
        'px',
    )
    renderLangChips()
  }
  const initialized = (async () => {
    try {
      await kit.ready
      renderLangChips()
      const migrated = await kit.load('translate_prefs_v2_migrated', false)
      if (!migrated) {
        const old = {
          srcLang: await kit.load('srcLang', null),
          tgtLang: await kit.load('tgtLang', null),
          engine: await kit.load('engine', null),
        }
        await kit.save('translate_prefs_v1_backup', old)
        for (const [key, value] of Object.entries(old)) {
          if (
            value &&
            (key === 'engine'
              ? ['auto', 'google', 'mymemory'].includes(value)
              : LANGS[value] && (key !== 'tgtLang' || value !== 'auto'))
          ) {
            await api.settings.set(key, value)
            kit.settings[key] = value
          }
        }
        await kit.save('translate_prefs_v2_migrated', true)
      }
      applyPrefs()
      const saved = await kit.load(KEY, { version: 2, history: [] })
      if (saved.version !== 2 || !Array.isArray(saved.history))
        throw Error('翻译历史格式异常，原数据已保留')
      history = saved.history.filter(
        (h) =>
          h &&
          typeof h.source === 'string' &&
          typeof h.text === 'string' &&
          typeof h.id === 'string',
      )
      loaded = true
      renderHistory()
    } catch (e) {
      kit.toast(e.message, 'error')
      $('history-list').innerHTML =
        '<div class="empty">历史读取失败，已停止写入历史。请重新打开插件。</div>'
    }
  })()
  kit.onSettings((_settings, key) => {
    const changed =
      (key === 'srcLang' && $('src').value !== kit.settings.srcLang) ||
      (key === 'tgtLang' && $('tgt').value !== kit.settings.tgtLang) ||
      (key === 'engine' && $('engine').value !== kit.settings.engine)
    applyPrefs()
    if (loaded && changed) {
      invalidate()
      result = null
      sync()
    }
  })
  renderLangChips()
  sync()
  api?.onEnter?.(async ({ payload }) => {
    await initialized
    const text =
      typeof payload === 'string'
        ? payload
        : payload?.type === 'text'
          ? payload.text
          : ''
    if (text) {
      $('input').value = text.slice(0, 10000)
      inputChanged()
      void run()
    }
  })
  api?.onBeforeClose?.(async () => {
    await initialized
    invalidate()
    return preferenceQueue
  })
})()
