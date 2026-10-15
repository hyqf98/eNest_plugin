/** Pure, local shell suggestions. No network, terminal writes, or guessed line editing. */
;(function (global) {
  const CONTROL = /[\x00-\x1f\x7f-\x9f]/
  const DEFAULTS = Object.freeze({ enabled: true, autoSuggest: true, commands: true, options: true, snippets: true, history: true, remotePaths: true, remoteCommands: false, minChars: 1, maxItems: 8 })

  function preferences(value = {}) {
    const result = { ...DEFAULTS }
    for (const key of ['enabled', 'autoSuggest', 'commands', 'options', 'snippets', 'history', 'remotePaths', 'remoteCommands']) if (typeof value[key] === 'boolean') result[key] = value[key]
    result.minChars = Math.max(1, Math.min(8, Number(value.minChars) || 1))
    result.maxItems = Math.max(4, Math.min(12, Number(value.maxItems) || 8))
    result.userCommands = (Array.isArray(value.userCommands) ? value.userCommands : []).slice(0, 200).filter(item => item && typeof item.command === 'string' && item.command.trim() && !CONTROL.test(item.command)).map(item => ({ command: item.command.slice(0, 2000), description: String(item.description || '').slice(0, 300) }))
    return result
  }

  /** Read only a complete simple-shell segment. Unclosed quotes/substitution stay with the shell. */
  function context(line) {
    if (typeof line !== 'string' || CONTROL.test(line) || line.length > 12000) return null
    let quote = '', escaped = false, token = '', tokenStart = 0, tokens = [], segmentStart = 0, quoted = false
    const finish = end => { if (token) tokens.push({ value: token, start: tokenStart, end, quoted }); token = ''; quoted = false }
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (escaped) { token += char; escaped = false; quoted = true; continue }
      if (char === '\\' && quote !== "'") { escaped = true; if (!token) tokenStart = i; continue }
      if (quote) { if (char === quote) quote = ''; else token += char; continue }
      if (char === '"' || char === "'") { if (!token) tokenStart = i; quote = char; quoted = true; continue }
      if (char === '`' || char === '$' && line[i + 1] === '(' || /[()<>]/.test(char)) return null
      if (char === '#' && !token) return null
      if (/[|;&]/.test(char)) { finish(i); tokens = []; segmentStart = i + 1; continue }
      if (/\s/.test(char)) { finish(i); continue }
      if (!token) tokenStart = i
      token += char
    }
    if (quote || escaped || quoted) return null
    const current = token, start = token ? tokenStart : line.length
    let words = tokens.map(item => item.value)
    // Assignments and explicit wrappers are recognized without evaluating their values.
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] || '')) words.shift()
    if (words[0] === 'sudo') {
      words.shift()
      while (words.length && words[0].startsWith('-')) {
        const option = words.shift()
        if (option === '--') break
        if (['-u', '-g', '-h', '-p', '-C', '-T'].includes(option)) { if (!words.length) return null; words.shift() }
        else if (!/^-[EHnSbkVv]+$/.test(option) && !/^--(?:user|group)=/.test(option)) return null
      }
    } else if (words[0] === 'env') {
      words.shift()
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] || '')) words.shift()
      if (words[0]?.startsWith('-')) return null
    } else if (words[0] === 'command') {
      words.shift(); if (words[0] === '--') words.shift()
      if (words[0]?.startsWith('-')) return null
    }
    return { current, start, words, segmentStart, segment: line.slice(segmentStart).trimStart() }
  }

  function suggest(line, sources = {}) {
    const prefs = preferences(sources.preferences)
    const parsed = context(line)
    if (!prefs.enabled || !parsed || !sources.force && (!prefs.autoSuggest || line.trim().length < prefs.minChars)) return []
    const dictionary = sources.dictionary || global.SshDict?.DICT || []
    const items = [], seen = new Set()
    const add = (kind, label, fullCommand, detail, rank, args = '') => {
      // Prefix-only append is independent of remote shell keymaps and preserves the existing command.
      if (!fullCommand || CONTROL.test(fullCommand) || !fullCommand.startsWith(line) || fullCommand === line || seen.has(fullCommand)) return
      seen.add(fullCommand)
      items.push({ kind, label, text: label, fullCommand, insertText: fullCommand.slice(line.length), detail: detail || '', arguments: args, rank })
    }
    if (!parsed.words.length && prefs.commands) {
      for (const entry of dictionary) if (entry.cmd.startsWith(parsed.current)) add('cmd', entry.cmd, line.slice(0, parsed.start) + entry.cmd, entry.desc, 10, entry.usage || '')
    } else if (prefs.options) {
      let definition = dictionary.find(entry => entry.cmd === parsed.words[0])
      const rootDefinition = definition, positional = []
      let valueOption = null, optionsEnded = false
      for (const word of parsed.words.slice(1)) {
        if (valueOption) { valueOption = null; continue }
        if (word === '--') { optionsEnded = true; continue }
        if (!optionsEnded && word.startsWith('-')) {
          const option = [...(definition?.flags || []), ...(rootDefinition?.flags || [])].find(item => item.name === word || word.startsWith(item.name + '='))
          if (option?.value && word === option.name) valueOption = option
          continue
        }
        const child = (definition?.subcommands || []).find(entry => entry.name === word)
        if (child && !positional.length && !optionsEnded) definition = child
        else positional.push(word)
      }
      if (definition) {
        const entries = optionsEnded ? [] : [
          ...(!positional.length && !parsed.current.startsWith('-') ? definition.subcommands || [] : []),
          ...(definition.flags || []).filter(flag => flag.name.startsWith('-') || !positional.length),
        ]
        const valueEntries = valueOption ? (valueOption.values || []).map(name => ({ name, desc: valueOption.desc, kind: 'value' })) : entries
        for (const item of valueEntries) {
          if (!item.name.startsWith(parsed.current) || parsed.words.includes(item.name) && item.name.startsWith('-')) continue
          add(item.kind || (item.name.startsWith('-') ? 'flag' : 'subcommand'), item.name, line.slice(0, parsed.start) + item.name, item.desc, 5, item.value || item.usage || '')
        }
      }
    }
    // Whole-line sources may extend the current line, never replace it or inject a newline.
    for (const item of prefs.userCommands) add('custom', item.command, item.command, item.description || '自定义命令', 15)
    if (prefs.snippets) for (const item of sources.snippets || []) {
      if (/<[^>]+>|\$\{\d/.test(item.command || '')) continue
      add('snippet', item.command, item.command, item.title || '快捷命令', 20)
    }
    if (prefs.history) {
      const history = [...(sources.history || [])].filter(item => item.command && (!sources.profileId || item.profileId === sources.profileId)).sort((a, b) => (b.ts || 0) - (a.ts || 0))
      for (const item of history) add('history', item.command, item.command, '当前连接的历史', 30)
    }
    return items.sort((a, b) => a.rank - b.rank).slice(0, prefs.maxItems)
  }

  function snapshotKey(snapshot) {
    return snapshot ? JSON.stringify([snapshot.promptId, snapshot.revision, snapshot.text, snapshot.cursor, snapshot.cwd]) : ''
  }

  function suffixFor(item, original, current) {
    if (!item || !original || !current || snapshotKey(original) !== snapshotKey(current) || current.cursor !== current.text.length) return null
    if (typeof item.fullCommand !== 'string' || CONTROL.test(item.fullCommand) || !item.fullCommand.startsWith(current.text)) return null
    const suffix = item.fullCommand.slice(current.text.length)
    return suffix && !CONTROL.test(suffix) ? suffix : null
  }

  global.SshCommandCompletion = { DEFAULTS, preferences, context, suggest, snapshotKey, suffixFor }
})(window)
