/**
 * code-core — 自研轻量 tokenizer（关键字/字符串/注释/数字四类）+ 语言识别 + canvas 排版测量纯逻辑。
 * 覆盖 JS/TS/JSON/Python/Java/Go/Rust/CSS/HTML/SQL/Bash 十一语言；无第三方依赖，可在 node 下自测。
 */
;(function (root) {
  const LANGUAGES = [
    { id: 'javascript', label: 'JavaScript' },
    { id: 'typescript', label: 'TypeScript' },
    { id: 'json', label: 'JSON' },
    { id: 'python', label: 'Python' },
    { id: 'java', label: 'Java' },
    { id: 'go', label: 'Go' },
    { id: 'rust', label: 'Rust' },
    { id: 'css', label: 'CSS' },
    { id: 'html', label: 'HTML' },
    { id: 'sql', label: 'SQL' },
    { id: 'bash', label: 'Bash' },
    { id: 'plaintext', label: '纯文本' }
  ]

  const KEYWORDS = {
    javascript: 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return static super switch this throw try typeof var void while with yield async await get set of'.split(' '),
    typescript: null, // 与 javascript 合并后追加
    json: 'true false null'.split(' '),
    python: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case'.split(' '),
    java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while var record sealed permits'.split(' '),
    go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false'.split(' '),
    rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' '),
    css: 'important media supports keyframes import charset font-face from to and not only'.split(' '),
    html: 'html head body div span script style link meta title'.split(' '),
    sql: 'select from where insert into values update set delete create table drop alter add index view join inner left right outer full on group by order asc desc limit offset having distinct as and or not null is like in between union all primary key foreign references default unique check constraint commit rollback begin transaction exists case when then else end count sum avg min max'.split(' '),
    bash: 'if then else elif fi for while do done case esac function return in local export readonly shift break continue exit echo cd source set unset trap'.split(' '),
    plaintext: []
  }
  KEYWORDS.typescript = [...new Set([...KEYWORDS.javascript, 'interface type enum namespace declare implements readonly private protected public abstract any unknown never string number boolean object keyof infer as satisfies'])]

  const IDENT_START = /[A-Za-z_$\u4e00-\u9fff]/
  const IDENT_PART = /[A-Za-z0-9_$\u4e00-\u9fff]/

  /** 启发式语言识别：扩展名提示 + 关键字/结构计分。 */
  function detectLanguage(code, hint = '') {
    const extMap = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', java: 'java', go: 'go', rs: 'rust', css: 'css', html: 'html', htm: 'html', vue: 'html', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash' }
    const ext = String(hint || '').split('.').pop().toLowerCase()
    if (extMap[ext]) return extMap[ext]
    const text = String(code ?? '')
    if (!text.trim()) return 'plaintext'
    const scores = {}
    const bump = (lang, amount) => { scores[lang] = (scores[lang] || 0) + amount }
    if (/^\s*[{[]/.test(text) && /"\s*:/.test(text)) bump('json', 6)
    if (/<\/?[a-z][^>]*>/i.test(text)) bump('html', 5)
    if (/^\s*(?:GET|POST|PUT|DELETE)\s|^\s*(?:select|insert|update|delete|create)\b/i.test(text)) bump('sql', 5)
    if (/^\s*#!/.test(text)) bump('bash', 6)
    if (/\bdef\s+\w+\s*\(|\bimport\s+\w+\s*$|\belif\b|\bfrom\s+\w+\s+import\b/m.test(text)) bump('python', 5)
    if (/:\s*(?:string|number|boolean|void|any|unknown)\b|<\w+>\(/m.test(text)) bump('typescript', 4)
    if (/\bfunc(?:tion)?\b|\b=>\b|\bconst\b|\blet\b|\bconsole\.log\b/m.test(text)) bump('javascript', 3)
    if (/\bfn\s+\w+|->\s*\w+\s*\{|\blet\s+mut\b|\bimpl\b/m.test(text)) bump('rust', 5)
    if (/\bfunc\s+\w+\s*\(|:=/m.test(text)) bump('go', 5)
    if (/\bpublic\s+(?:static\s+)?(?:void|class|int)\b/m.test(text)) bump('java', 5)
    if (/[.#]?[\w-]+\s*\{[^}]*:[^}]*;/m.test(text)) bump('css', 3)
    if (/\$\{?[A-Za-z_]\w*\}?\b|\becho\b/m.test(text)) bump('bash', 2)
    let best = 'plaintext', top = 2
    for (const [lang, score] of Object.entries(scores)) if (score > top) { top = score; best = lang }
    return best
  }

  /**
   * 逐行 tokenizer：返回 Array<Array<{ text, kind }>>。
   * kind ∈ plain | keyword | string | comment | number
   */
  function tokenize(code, language = 'plaintext') {
    const keywords = new Set(KEYWORDS[language] || [])
    const lines = String(code ?? '').replace(/\r\n?/g, '\n').split('\n')
    return lines.map(line => tokenizeLine(line, keywords, language))
  }

  function pushToken(tokens, text, kind) {
    if (!text) return
    const last = tokens[tokens.length - 1]
    if (last && last.kind === kind) last.text += text
    else tokens.push({ text, kind })
  }

  function tokenizeLine(line, keywords, language) {
    const tokens = []
    let index = 0
    const rest = () => line.slice(index)
    const startsWith = value => line.startsWith(value, index)
    const htmlMode = language === 'html'

    while (index < line.length) {
      // HTML 优先处理标签与注释
      if (htmlMode && startsWith('<!--')) {
        const end = line.indexOf('-->', index)
        const text = end >= 0 ? line.slice(index, end + 3) : rest()
        pushToken(tokens, text, 'comment'); index += text.length; continue
      }
      if (htmlMode && startsWith('<')) {
        const match = /^<\/?[A-Za-z][\w:-]*/.exec(rest())
        if (match) {
          pushToken(tokens, match[0], 'keyword'); index += match[0].length
          // 标签内属性与字符串
          while (index < line.length && line[index] !== '>') {
            if (line[index] === '"' || line[index] === "'") {
              const quote = line[index]
              let end = index + 1
              while (end < line.length && line[end] !== quote) end += 1
              pushToken(tokens, line.slice(index, Math.min(end + 1, line.length)), 'string')
              index = Math.min(end + 1, line.length)
            } else {
              const attr = /^[A-Za-z-][\w-]*/.exec(rest())
              if (attr) { pushToken(tokens, attr[0], 'plain'); index += attr[0].length }
              else { pushToken(tokens, line[index], 'plain'); index += 1 }
            }
          }
          if (index < line.length) { pushToken(tokens, '>', 'keyword'); index += 1 }
          continue
        }
      }
      // 注释
      if (language === 'bash' || language === 'python') {
        if (line[index] === '#') { pushToken(tokens, rest(), 'comment'); break }
      }
      if (language === 'sql' && (startsWith('--') || startsWith('//'))) { pushToken(tokens, rest(), 'comment'); break }
      if (language !== 'bash' && language !== 'python' && language !== 'sql' && startsWith('//')) { pushToken(tokens, rest(), 'comment'); break }
      if (startsWith('/*')) {
        const end = line.indexOf('*/', index + 2)
        const text = end >= 0 ? line.slice(index, end + 2) : rest()
        pushToken(tokens, text, 'comment'); index += text.length; continue
      }
      // 字符串（含转义）
      if (line[index] === '"' || line[index] === "'" || (language !== 'sql' && line[index] === '`')) {
        const quote = line[index]
        let end = index + 1
        while (end < line.length) {
          if (line[end] === '\\') { end += 2; continue }
          if (line[end] === quote) { end += 1; break }
          end += 1
        }
        pushToken(tokens, line.slice(index, Math.min(end, line.length)), 'string')
        index = Math.min(end, line.length); continue
      }
      // 数字
      if (/[0-9]/.test(line[index])) {
        const match = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest())
        const text = match ? match[0] : line[index]
        pushToken(tokens, text, 'number'); index += text.length; continue
      }
      // 标识符 / 关键字
      if (IDENT_START.test(line[index])) {
        const match = /^[\w$\u4e00-\u9fff]+/.exec(rest())
        const word = match ? match[0] : line[index]
        pushToken(tokens, word, keywords.has(word) ? 'keyword' : 'plain')
        index += word.length; continue
      }
      pushToken(tokens, line[index], 'plain')
      index += 1
    }
    return tokens
  }

  /** 行号栏宽度（等宽字体度量数）。 */
  function gutterWidth(lineCount) {
    return String(Math.max(1, lineCount)).length
  }

  /** 画布布局：逐行测量返回换行后的绘制行（等宽字体断行）。 */
  function layoutLines(tokens, maxColumns) {
    const rows = []
    tokens.forEach((tokensOfLine, lineIndex) => {
      let column = 0
      let current = { number: lineIndex + 1, tokens: [] }
      for (const token of tokensOfLine) {
        let remaining = token.text
        while (remaining.length) {
          const space = maxColumns - column
          if (space <= 0) { rows.push(current); current = { number: '', tokens: [] }; column = 0; continue }
          const take = Math.min(space, remaining.length)
          pushToken(current.tokens, remaining.slice(0, take), token.kind)
          column += take
          remaining = remaining.slice(take)
          if (remaining.length) { rows.push(current); current = { number: '', tokens: [] }; column = 0 }
        }
      }
      rows.push(current)
    })
    return rows
  }

  /** 语法色板：全部由主题 token 派生（暗色深底 / 亮色浅底）。 */
  function syntaxPalette(tokens, mode) {
    const pick = name => String(tokens?.[name] || '').trim()
    const accent = pick('--accent') || (mode === 'dark' ? '#e98654' : '#bd542b')
    const text = pick('--text') || (mode === 'dark' ? '#f2f3f3' : '#292c2e')
    const muted = pick('--text-2') || (mode === 'dark' ? '#adb3b8' : '#666c70')
    return {
      background: pick('--surface') || (mode === 'dark' ? '#202326' : '#ffffff'),
      header: pick('--surface-2') || (mode === 'dark' ? '#292d31' : '#eeefed'),
      border: pick('--border-strong') || (mode === 'dark' ? 'rgba(242,243,243,.16)' : 'rgba(41,44,46,.16)'),
      title: muted,
      plain: text,
      keyword: accent,
      string: pick('--ok') || (mode === 'dark' ? '#77bfa4' : '#318469'),
      comment: muted,
      number: pick('--link') || accent,
      gutter: muted,
      dot: mode === 'dark' ? 'rgba(242,243,243,.28)' : 'rgba(41,44,46,.24)'
    }
  }

  /** 代码文字颜色总在纯色底上渲染，确保透明画布下仍可读。 */
  function measure(code, font) {
    return String(code ?? '').split('\n').reduce((max, line) => Math.max(max, line.length), 0)
  }

  root.CodeCore = { LANGUAGES, KEYWORDS, detectLanguage, tokenize, layoutLines, gutterWidth, syntaxPalette, measure }
})(globalThis)
