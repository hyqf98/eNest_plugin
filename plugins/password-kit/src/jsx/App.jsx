/**
 * 密码工具箱主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 generatePassword/generatePassphrase/uuidV4/熵估算 复用 core.mjs（未改动）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CHARACTER_SETS,
  generatePassword,
  generatePassphrase,
  generatePin,
  uuidV4,
  entropyEstimate,
  passphraseEntropy,
  pinEntropy,
  guessEntropy,
  crackTimeEstimate,
  strengthIssues,
} from '../js/core.mjs'

const api = window.enest || window.zapi
const HISTORY_KEY = 'password_kit.history.v1'

// —— 模式描述（footer 隐私提示随模式切换，传达「责任」）——
const KIND_META = {
  password: { title: '生成结果', privacy: '密码仅在当前会话保留，关闭插件后清除' },
  passphrase: { title: '生成结果', privacy: '密码短语在本地生成，会话结束即清除' },
  pin: { title: '生成结果', privacy: 'PIN 在本地生成，会话结束即清除' },
  uuid: { title: '生成结果', privacy: '随机 UUID v4 · 本地生成' },
  inspect: { title: '强度报告', privacy: '分析完全本地进行：不上传、不存储输入的密码' },
}

const LEVEL_WORDS = { weak: '弱', fair: '一般', strong: '强' }
const levelOf = (bits) => (bits < 45 ? 'weak' : bits < 70 ? 'fair' : 'strong')

export function App() {
  const kitRef = useRef(null)
  const historyEnabledRef = useRef(true)

  const [kind, setKind] = useState('password')
  const [values, setValues] = useState([])
  const [history, setHistory] = useState([])
  const [masked, setMasked] = useState(true)
  const [inspectText, setInspectText] = useState('')
  const [errorText, setErrorText] = useState('')

  // —— password 面板参数 ——//
  const [length, setLength] = useState(16)
  const [lower, setLower] = useState(true)
  const [upper, setUpper] = useState(true)
  const [digit, setDigit] = useState(true)
  const [symbol, setSymbol] = useState(true)
  const [ambiguous, setAmbiguous] = useState(false)
  const [exclude, setExclude] = useState('')
  // —— passphrase ——//
  const [words, setWords] = useState(4)
  const [phraseSeparator, setPhraseSeparator] = useState('-')
  const [phraseCapitalize, setPhraseCapitalize] = useState(false)
  const [phraseNumber, setPhraseNumber] = useState(true)
  // —— pin ——//
  const [pinLength, setPinLength] = useState(6)
  // —— uuid ——//
  const [uppercase, setUppercase] = useState(false)
  const [hyphens, setHyphens] = useState(true)
  const [separator, setSeparator] = useState('newline')
  const [count, setCount] = useState(1)

  const stateRef = useRef({})
  stateRef.current = {
    kind, values, history, masked, inspectText, length,
    lower, upper, digit, symbol, ambiguous, exclude,
    words, phraseSeparator, phraseCapitalize, phraseNumber,
    pinLength, uppercase, hyphens, separator, count,
  }

  const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Math.round(Number(value) || fallback)))

  // —— 参数面板（等价原 passwordOptions / passphraseOptions / bitsForCurrent）——//
  const passwordOptions = useCallback(() => {
    const s = stateRef.current
    return {
      length: s.length,
      sets: Object.keys(CHARACTER_SETS).filter((key) =>
        key === 'lower' ? s.lower : key === 'upper' ? s.upper : key === 'digit' ? s.digit : s.symbol),
      avoidAmbiguous: s.ambiguous,
      exclude: s.exclude,
    }
  }, [])

  const passphraseOptions = useCallback(() => {
    const s = stateRef.current
    return {
      words: s.words,
      separator: s.phraseSeparator,
      capitalize: s.phraseCapitalize,
      appendNumber: s.phraseNumber,
    }
  }, [])

  const bitsForCurrent = useCallback(() => {
    const s = stateRef.current
    if (s.kind === 'password') return entropyEstimate(passwordOptions())
    if (s.kind === 'passphrase') return passphraseEntropy(passphraseOptions())
    if (s.kind === 'pin') return pinEntropy(s.pinLength)
    return null
  }, [passwordOptions, passphraseOptions])

  const entropyLine = (() => {
    try {
      const bits = bitsForCurrent()
      return bits == null ? '' : `约 ${bits} bits 随机熵（字符池上限估计）`
    } catch {
      return ''
    }
  })()

  // —— 强度校验（等价原 strength()：password 面板参数非法时禁用生成）——//
  const [generateDisabled, setGenerateDisabled] = useState(false)
  useEffect(() => {
    if (kind === 'inspect') return
    try {
      entropyEstimate(passwordOptions())
      setErrorText('')
      setGenerateDisabled(false)
    } catch (e) {
      if (kind === 'password') {
        setErrorText(e.message)
        setGenerateDisabled(true)
      }
    }
  }, [kind, length, lower, upper, digit, symbol, ambiguous, exclude, passwordOptions])

  // —— 强度检查报告（等价原 renderInspect）——//
  const report = (() => {
    if (kind !== 'inspect' || !inspectText) return null
    const bits = guessEntropy(inspectText)
    const level = levelOf(bits)
    const crack = crackTimeEstimate(bits)
    const issues = strengthIssues(inspectText)
    return { bits, level, crack, issues }
  })()

  // —— 结果行展示文本（掩码 + 悬停临时揭示，等价原 row()）——//
  const display = (value, isHistory) => {
    const s = stateRef.current
    return s.masked && (s.kind === 'password' || s.kind === 'passphrase' || s.kind === 'pin' || isHistory)
      ? '•'.repeat(Math.min(24, value.length))
      : value
  }

  async function copy(text) {
    try {
      // 生成结果写剪贴板时避免进入剪贴板历史明文：优先带排除标记
      await api.clipboard.writeText(String(text), { excludeFromHistory: true })
      kitRef.current?.toast('已复制', 'success')
      return true
    } catch (error) {
      return kitRef.current.copy(text).catch((err) => {
        kitRef.current.toast(err.message, 'error')
        return false
      })
    }
  }

  const formatted = () => {
    const s = stateRef.current
    if (s.kind !== 'uuid' || s.separator === 'newline') return s.values.join('\n')
    if (s.separator === 'json') return JSON.stringify(s.values, null, 2)
    return s.values.join(',')
  }

  // —— 生成（等价原 generate()）——//
  const generate = useCallback((copyAfter = false) => {
    const s = stateRef.current
    const kit = kitRef.current
    try {
      const n = Number(s.count)
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('数量应为 1–100 的整数')
      const makeOne = () => {
        if (s.kind === 'password') return generatePassword(passwordOptions())
        if (s.kind === 'passphrase') return generatePassphrase(passphraseOptions())
        if (s.kind === 'pin') return generatePin(s.pinLength)
        return uuidV4({ uppercase: s.uppercase, hyphens: s.hyphens })
      }
      const next = Array.from({ length: n }, makeOne)
      setValues(next)
      setErrorText('')
      if (s.kind !== 'uuid' && historyEnabledRef.current) {
        setHistory((prev) => {
          const rows = [...next, ...prev].slice(0, 12)
          void kit.save(HISTORY_KEY, rows).catch(() => {})
          return rows
        })
      }
      if (copyAfter) copy(formatted())
    } catch (e) {
      setValues([])
      setErrorText(e.message)
    }
  }, [passwordOptions, passphraseOptions])

  const clearHistory = useCallback(() => {
    setHistory([])
    void kitRef.current?.save(HISTORY_KEY, []).catch(() => {})
  }, [])

  // latest-ref 桥接：宿主回调里始终调到最新逻辑
  const generateRef = useRef(generate)
  generateRef.current = generate
  const setLengthClamped = useCallback((value) => setLength(clamp(value, 6, 128, 16)), [])
  const changeKindRef = useRef(null)

  // —— 宿主适配器（latest-ref 桥接，等价原 PluginKit.create 配置）——//
  useEffect(() => {
    const kit = PluginKit.create({
      title: '密码工具箱',
      quickPlaceholder: '输入长度、uuid 或 strength',
      height: 540,
      defaults: {
        defaultLength: 16,
        avoidAmbiguous: false,
        maskResults: true,
        uuidUppercase: false,
        uuidHyphens: true,
        keepHistory: true,
      },
      onQuery(text) {
        if (/strength|强度/i.test(text)) changeKindRef.current?.('inspect')
        else if (/uuid/i.test(text)) changeKindRef.current?.('uuid')
        else if (/pin|密码/i.test(text) === false && /^\d{1,3}$/.test(text.trim())) {
          changeKindRef.current?.('password')
          setLengthClamped(Number(text))
        }
      },
      onAction(action) {
        if (action === 'submit') generateRef.current(true)
        else if (action === 'clear') setValues([])
      },
    })
    kitRef.current = kit
    kit.onSettings((settings) => {
      historyEnabledRef.current = settings.keepHistory !== false
      setLengthClamped(settings.defaultLength)
      setAmbiguous(Boolean(settings.avoidAmbiguous))
      setMasked(settings.maskResults !== false)
      setUppercase(Boolean(settings.uuidUppercase))
      setHyphens(settings.uuidHyphens !== false)
      if (!historyEnabledRef.current) clearHistory()
    })
    api?.onEnter?.(({ code, payload }) => {
      const text = typeof payload === 'string' ? payload : payload?.text
      if (code === 'uuid' || text === 'uuid') changeKindRef.current?.('uuid')
      else if (code === 'password') changeKindRef.current?.('password')
      else if (code === 'inspect') changeKindRef.current?.('inspect')
      if (/^\d{1,3}$/.test(text || '')) setLengthClamped(Number(text))
    })
    api?.onDestroy?.(() => {
      setValues([])
      setHistory([])
      setInspectText('')
    })
    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      historyEnabledRef.current = kit.settings.keepHistory !== false
      setLengthClamped(kit.settings.defaultLength)
      setAmbiguous(Boolean(kit.settings.avoidAmbiguous))
      setMasked(kit.settings.maskResults !== false)
      setUppercase(Boolean(kit.settings.uuidUppercase))
      setHyphens(kit.settings.uuidHyphens !== false)
      try {
        const saved = await kit.load(HISTORY_KEY, [])
        if (alive && historyEnabledRef.current && Array.isArray(saved)) setHistory(saved.map(String).slice(0, 12))
      } catch {}
    })()
    return () => { alive = false; kit.destroy?.() }
  }, [clearHistory, setLengthClamped])

  // —— Enter 生成（等价原 document keydown）——//
  useEffect(() => {
    const onKeyDown = (e) => {
      if (
        e.key === 'Enter' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.isComposing &&
        e.target.tagName !== 'BUTTON' &&
        e.target.id !== 'inspect-input'
      ) {
        e.preventDefault()
        generateRef.current(e.shiftKey)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const panelName = kind === 'inspect' ? 'inspect' : kind
  const genOnly = kind !== 'inspect'

  return (
    <main className="pkgen">
      <header className="app-bar">
        <h1 className="shell-only">密码工具箱</h1>
        <nav className="segmented" role="tablist" aria-label="工具模式">
          {['password', 'passphrase', 'pin', 'uuid', 'inspect'].map((k) => (
            <button key={k} role="tab" data-kind={k} aria-selected={kind === k}
              onClick={() => setKind(k)}>{ { password: '密码', passphrase: '密码短语', pin: 'PIN', uuid: 'UUID v4', inspect: '强度检查' }[k] }</button>
          ))}
        </nav>
        <span className="grow"></span>
        <button id="mask" className="pk-btn ghost shell-only" aria-pressed={masked} hidden={kind === 'inspect'}
          onClick={() => setMasked((m) => !m)}>{masked ? '显示内容' : '隐藏内容'}</button>
      </header>

      <div className="layout">
        <aside className="params" aria-label="参数">
          <section className="panel" data-panel="password" hidden={panelName !== 'password'}>
            <label className="field-label" htmlFor="length">长度 <output id="length-value">{length}</output></label>
            <div className="length-control">
              <input id="length" type="range" min="6" max="128" value={length} aria-label="密码长度"
                onInput={(e) => setLengthClamped(e.target.value)} />
              <input id="length-number" type="number" min="6" max="128" value={length} aria-label="长度数字"
                onChange={(e) => setLengthClamped(e.target.value)} />
            </div>
            <div className="presets">
              {[12, 16, 24, 32, 64].map((n) => (
                <button key={n} data-length={n} onClick={() => setLengthClamped(n)}>{n}</button>
              ))}
            </div>
            <fieldset>
              <legend>字符集</legend>
              <label><input id="lower" type="checkbox" checked={lower} onChange={(e) => setLower(e.target.checked)} /> 小写 a–z</label>
              <label><input id="upper" type="checkbox" checked={upper} onChange={(e) => setUpper(e.target.checked)} /> 大写 A–Z</label>
              <label><input id="digit" type="checkbox" checked={digit} onChange={(e) => setDigit(e.target.checked)} /> 数字 0–9</label>
              <label><input id="symbol" type="checkbox" checked={symbol} onChange={(e) => setSymbol(e.target.checked)} /> 符号 !@#</label>
            </fieldset>
            <label className="check">
              <input id="ambiguous" type="checkbox" checked={ambiguous} onChange={(e) => setAmbiguous(e.target.checked)} /> 排除易混淆字符 O0oIl1|</label>
            <details className="advanced">
              <summary>自定义排除字符</summary>
              <input id="exclude" aria-label="排除字符" placeholder='例如 {}[]/\' value={exclude}
                onChange={(e) => setExclude(e.target.value)} />
            </details>
          </section>

          <section className="panel" data-panel="passphrase" hidden={panelName !== 'passphrase'}>
            <label className="field-label" htmlFor="words">单词数 <output id="words-value">{words}</output></label>
            <input id="words" type="range" min="2" max="12" value={words} aria-label="单词数"
              onInput={(e) => setWords(clamp(e.target.value, 2, 12, 4))} />
            <div className="presets">
              {[3, 4, 5, 6].map((n) => (
                <button key={n} data-words={n} onClick={() => setWords(n)}>{n} 词</button>
              ))}
            </div>
            <label className="field-label" htmlFor="phrase-separator">分隔符</label>
            <select id="phrase-separator" value={phraseSeparator} onChange={(e) => setPhraseSeparator(e.target.value)}>
              <option value="-">连字符 -</option>
              <option value=".">点 .</option>
              <option value="_">下划线 _</option>
              <option value=" ">空格</option>
              <option value="">无分隔</option>
            </select>
            <label className="check"><input id="phrase-capitalize" type="checkbox" checked={phraseCapitalize} onChange={(e) => setPhraseCapitalize(e.target.checked)} /> 首字母大写</label>
            <label className="check"><input id="phrase-number" type="checkbox" checked={phraseNumber} onChange={(e) => setPhraseNumber(e.target.checked)} /> 末尾追加两位数字</label>
            <p className="panel-note">内置 1500+ 英文短词，词表与拼接全部本地随机。</p>
          </section>

          <section className="panel" data-panel="pin" hidden={panelName !== 'pin'}>
            <label className="field-label" htmlFor="pin-length">位数 <output id="pin-length-value">{pinLength}</output></label>
            <input id="pin-length" type="range" min="4" max="16" value={pinLength} aria-label="PIN 位数"
              onInput={(e) => setPinLength(clamp(e.target.value, 4, 16, 6))} />
            <div className="presets">
              {[4, 6, 8, 12].map((n) => (
                <button key={n} data-pin={n} onClick={() => setPinLength(n)}>{n} 位</button>
              ))}
            </div>
            <p className="panel-note">纯数字。适合设备配对码、取件码等短窗口场景，不建议做主密码。</p>
          </section>

          <section className="panel" data-panel="uuid" hidden={panelName !== 'uuid'}>
            <p className="panel-note">
              随机 UUID v4，适合记录 ID、测试数据与本地开发。每个 UUID 携带约 122 位随机性。
            </p>
            <label className="check"><input id="uppercase" type="checkbox" checked={uppercase} onChange={(e) => setUppercase(e.target.checked)} /> 大写字母</label>
            <label className="check"><input id="hyphens" type="checkbox" checked={hyphens} onChange={(e) => setHyphens(e.target.checked)} /> 保留连字符</label>
            <label className="field-label" htmlFor="separator">批量复制格式</label>
            <select id="separator" value={separator} onChange={(e) => setSeparator(e.target.value)}>
              <option value="newline">每行一个</option>
              <option value="comma">逗号分隔</option>
              <option value="json">JSON 数组</option>
            </select>
          </section>

          <section className="panel" data-panel="inspect" hidden={panelName !== 'inspect'}>
            <label className="field-label" htmlFor="inspect-input">要检查的密码</label>
            <textarea
              id="inspect-input"
              rows="3"
              spellCheck="false"
              placeholder="输入或粘贴密码，分析只在本插件内进行"
              value={inspectText}
              onChange={(e) => setInspectText(e.target.value)}
            ></textarea>
            <p className="panel-note">完全本地分析：估算熵、覆盖字符类、常见结构弱点，不联网、不存储。</p>
          </section>

          <p id="entropy-line" className="panel-note" data-gen-only hidden={!genOnly}>{entropyLine}</p>

          <div className="quantity" data-gen-only hidden={!genOnly}>
            <label htmlFor="count">生成数量</label>
            <input id="count" type="number" min="1" max="100" value={count}
              onChange={(e) => setCount(e.target.value === '' ? '' : Number(e.target.value))} />
          </div>
          <div className="gen-actions" data-gen-only hidden={!genOnly}>
            <button className="pk-btn primary" id="generate" disabled={generateDisabled} onClick={() => generate()}>生成</button>
            <button id="generate-copy" className="pk-btn primary" disabled={generateDisabled} onClick={() => generate(true)}>生成并复制</button>
          </div>
          <p id="error" role="alert">{errorText}</p>
        </aside>

        <section className="board">
          <div className="board-head">
            <h2 id="board-title">{KIND_META[kind].title}</h2>
            <span id="result-count" className="muted">{values.length ? values.length + ' 条' : ''}</span>
            <span className="grow" data-gen-only hidden={!genOnly}></span>
            <button id="copy-all" className="pk-btn" disabled={!values.length} data-gen-only hidden={!genOnly}
              onClick={() => values.length && copy(formatted())}>全部复制</button>
            <button id="clear-results" className="pk-btn ghost" data-gen-only hidden={!genOnly}
              onClick={() => setValues([])}>清空</button>
          </div>
          <div className="board-scroll">
            <div id="inspect-report" className="report" hidden={!report}>
              {report && (
                <>
                  <div className="verdict">
                    <span className="score-word" data-level={report.level}>{LEVEL_WORDS[report.level]}</span>
                    <span className="score-bits">≈ {report.bits} bits</span>
                  </div>
                  <div className="meter"><i data-level={report.level} style={{ width: Math.min(100, report.bits) + '%' }}></i></div>
                  <p className="crack-line">离线慢哈希场景下，估算破解时间 <b>{report.crack.value}</b></p>
                  {report.issues.length > 0 && (
                    <ul className="issues">
                      {report.issues.map((issue, i) => <li key={i}>{issue}</li>)}
                    </ul>
                  )}
                </>
              )}
            </div>
            <div id="results" className="results">
              {values.length === 0 ? (
                <p className="empty">设置参数后点击生成。<br />每条结果都可以单独复制。</p>
              ) : (
                values.map((v, i) => <SecretRow key={`${i}-${v}`} value={v} index={i} masked={masked} reveal={display(v, false)} onCopy={() => copy(v)} />)
              )}
            </div>
            <details id="history-details" className="recent" hidden={kind === 'inspect' || !historyEnabledRef.current}>
              <summary>
                <span>生成历史</span><span id="history-count" className="muted">{history.length ? history.length + ' 条' : ''}</span>
                <button id="clear-history" className="pk-btn ghost" onClick={(e) => { e.preventDefault(); clearHistory() }}>清空</button>
              </summary>
              <div id="history">
                {history.map((v, i) => <SecretRow key={`${i}-${v}`} value={v} index={i} isHistory masked={masked} reveal={display(v, true)} onCopy={() => copy(v)} />)}
              </div>
            </details>
          </div>
        </section>
      </div>

      <footer>
        <span id="privacy">{KIND_META[kind].privacy}</span>
        <span className="shell-only">Enter 生成 · 按住条目可临时显示 · 点击复制</span>
      </footer>
    </main>
  )
}

/** 结果行（等价原 row()：点击复制，掩码时悬停临时揭示） */
function SecretRow({ value, index, isHistory, masked, reveal, onCopy }) {
  const [shown, setShown] = useState(false)
  const text = !masked ? value : shown ? value : reveal
  return (
    <button
      className="secret-row"
      aria-label={'复制第 ' + (index + 1) + ' 条'}
      onClick={onCopy}
      onPointerEnter={() => masked && setShown(true)}
      onPointerLeave={() => masked && setShown(false)}
    >
      <span className="number">{String(index + 1).padStart(2, '0')}</span>
      <span className="secret">{text}</span>
      <span className="action">复制</span>
    </button>
  )
}
