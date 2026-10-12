      const api = window.enest || window.zapi
      const $ = (id) => document.getElementById(id)
      let debounceTimer = null
      let current = { ok: false, value: NaN, text: '' } // 当前结果态

      const toast = async (message, type = 'info') => {
        try { await api?.ui?.toast?.({ message, type }) } catch {}
      }

      /* ================= 安全求值：tokenizer + 递归下降 parser =================
         文法：
           expr    := term (('+'|'-') term)*
           term    := factor (('*'|'/'|'%') factor)*
           factor  := unary primary（一元负号仅表达式开头 / '(' 之后允许）
           primary := number | '(' expr ')'
         连续操作符（"1+-2"、"3--2"）一律报错；严禁 eval / new Function。
         语法错误 / 除零以结构化错误返回。
      ======================================================================== */

      class CalcError extends Error {
        constructor(kind, msg) { super(msg); this.kind = kind }
      }

      function tokenize(src) {
        const tokens = []
        let i = 0
        while (i < src.length) {
          const ch = src[i]
          if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue }
          if (/[0-9.]/.test(ch)) {
            let j = i, dots = 0
            while (j < src.length && /[0-9.]/.test(src[j])) {
              if (src[j] === '.') dots++
              j++
            }
            const raw = src.slice(i, j)
            if (dots > 1 || raw === '.') throw new CalcError('syntax', '数字格式错误')
            tokens.push({ type: 'num', value: parseFloat(raw) })
            i = j
            continue
          }
          if ('+-*/%()'.includes(ch)) { tokens.push({ type: ch }); i++; continue }
          throw new CalcError('syntax', '无法识别的字符 "' + ch + '"')
        }
        return tokens
      }

      function parse(tokens) {
        let pos = 0
        const peek = () => tokens[pos]
        const next = () => tokens[pos++]
        const isOp = (t, ...ops) => t && t.type !== 'num' && ops.includes(t.type)

        function parseExpr() {
          let left = parseTerm(true)
          while (isOp(peek(), '+', '-')) {
            const op = next().type
            const right = parseTerm(false)
            left = op === '+' ? left + right : left - right
          }
          return left
        }

        function parseTerm(allowUnary) {
          let left = parseFactor(allowUnary)
          while (isOp(peek(), '*', '/', '%')) {
            const op = next().type
            const right = parseFactor(false)
            if (op === '*') left = left * right
            else {
              if (right === 0) throw new CalcError('div0', '不能除以 0')
              left = op === '/' ? left / right : left % right
            }
          }
          return left
        }

        // 一元负号仅允许出现在表达式开头或 '(' 之后（"-1+2"、"-(2+3)"）；
        // 连续操作符（"1+-2"、"3--2"）直接报错，行为可预期
        function parseFactor(allowUnary) {
          if (allowUnary && isOp(peek(), '-')) { next(); return -parsePrimary() }
          return parsePrimary()
        }

        function parsePrimary() {
          const t = peek()
          if (!t) throw new CalcError('incomplete', '表达式不完整')
          if (t.type === 'num') { next(); return t.value }
          if (t.type === '(') {
            next()
            const v = parseExpr() // '(' 之后重新允许一元负号
            if (!isOp(peek(), ')')) throw new CalcError('syntax', '括号不匹配')
            next()
            return v
          }
          throw new CalcError('syntax', '表达式不完整/错误')
        }

        const value = parseExpr()
        if (pos !== tokens.length) throw new CalcError('syntax', '表达式不完整/错误')
        return value
      }

      function formatNumber(v) {
        if (!Number.isFinite(v)) return 'NaN'
        // toPrecision(12) 去 IEEE 尾差（0.1+0.2 → 0.3），再 Number() 归一
        const n = Number(v.toPrecision(12))
        if (Number.isInteger(n)) return String(n)
        return String(n)
      }

      function evaluate(src) {
        const trimmed = src.trim()
        if (!trimmed) return { ok: false, empty: true }
        try {
          const value = parse(tokenize(trimmed))
          if (!Number.isFinite(value)) return { ok: false, empty: false, text: '结果溢出', err: true }
          return { ok: true, value, text: formatNumber(value) }
        } catch (e) {
          if (e instanceof CalcError) {
            const text = e.kind === 'div0' ? '不能除以 0' : '表达式不完整/错误'
            return { ok: false, empty: false, text, err: true }
          }
          return { ok: false, empty: false, text: '表达式不完整/错误', err: true }
        }
      }

      /* ================= 显示与交互 ================= */

      function renderResult() {
        const r = current
        const el = $('result')
        const copyBtn = $('btn-copy')
        if (r.empty) {
          el.textContent = '即输即算'
          el.className = 'empty'
          copyBtn.hidden = true
          return
        }
        el.textContent = r.text + (r.ok ? ' =' : '')
        el.className = r.ok ? '' : 'err'
        copyBtn.hidden = !r.ok
      }

      function recompute() {
        current = evaluate($('expr').value)
        renderResult()
      }

      function scheduleRecompute() {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(recompute, 150)
      }

      // —— 历史记录（会话内，最多 12 条，最新在上）——
      const history = []

      function renderHistory() {
        const list = $('history-list')
        list.innerHTML = ''
        const countEl = $('history-count')
        if (countEl) {
          countEl.textContent = String(history.length)
          countEl.hidden = history.length === 0
        }
        $('history-empty').style.display = history.length ? 'none' : ''
        for (const item of history) {
          const li = document.createElement('li')
          li.title = '点击回填输入框'

          const exprSpan = document.createElement('span')
          exprSpan.className = 'expr-h'
          exprSpan.textContent = item.expr + ' ='

          const resSpan = document.createElement('span')
          resSpan.className = 'res-h'
          resSpan.textContent = item.res

          const copyBtn = document.createElement('button')
          copyBtn.className = 'copy-h'
          copyBtn.textContent = '复制'
          copyBtn.title = '复制结果'
          copyBtn.onclick = (e) => { e.stopPropagation(); copyText(item.res) }

          li.append(exprSpan, resSpan, copyBtn)
          li.onclick = () => {
            $('expr').value = item.expr
            recompute()
            $('expr').focus()
          }
          list.appendChild(li)
        }
      }

      function confirmExpr() {
        const src = $('expr').value.trim()
        if (!src) return
        const r = evaluate(src)
        if (!r.ok) { recompute(); return } // 错误表达式不入历史，仅刷新提示
        const entry = { expr: src, res: r.text }
        history.unshift(entry)
        if (history.length > 12) history.length = 12
        renderHistory()
        // 结果写回输入框，便于链式计算
        $('expr').value = r.text
        current = { ok: true, value: r.value, text: r.text }
        renderResult()
        flashDisplay() // 写回 120ms 高亮过渡
      }

      /* ================= 纯 UI 辅助（不影响计算逻辑） ================= */

      // 确认写回：输入井 120ms 主色呼吸，传达"结果已写入"
      let flashTimer = null
      function flashDisplay() {
        const display = document.querySelector('.display')
        if (!display) return
        display.classList.add('settled')
        clearTimeout(flashTimer)
        flashTimer = setTimeout(() => display.classList.remove('settled'), 200)
      }

      // 双形态：宽容器（主窗 >740px）历史常驻展开；窄容器（Quick）收起、可点开。
      // 与 CSS @container (width > 740px) 同阈值同数据源（容器宽，而非视口宽）。
      const historyDetails = $('history')
      const appEl = document.querySelector('.app')
      const syncHistoryForm = (widerThan740) => {
        if (historyDetails) historyDetails.open = widerThan740
      }
      if (appEl && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver((entries) => {
          const w = entries[entries.length - 1]?.contentRect?.width ?? 0
          syncHistoryForm(w > 740)
        }).observe(appEl)
        syncHistoryForm(appEl.getBoundingClientRect().width > 740)
      } else {
        const mq = window.matchMedia('(min-width: 741px)')
        const onMq = () => syncHistoryForm(mq.matches)
        mq.addEventListener?.('change', onMq)
        onMq()
      }

      function insertKey(k) {
        const input = $('expr')
        if (k === 'AC') {
          input.value = ''
          recompute()
          return
        }
        if (k === '⌫') {
          const s = input.selectionStart
          const e = input.selectionEnd
          if (s === e && s > 0) input.value = input.value.slice(0, s - 1) + input.value.slice(e)
          else input.value = input.value.slice(0, s) + input.value.slice(e)
          input.selectionStart = input.selectionEnd = Math.max(0, s === e ? s - 1 : s)
          recompute()
          return
        }
        if (k === '=') { confirmExpr(); return }
        const s = input.selectionStart
        const e = input.selectionEnd
        input.value = input.value.slice(0, s) + k + input.value.slice(e)
        input.selectionStart = input.selectionEnd = s + 1
        scheduleRecompute()
      }

      $('pad').addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-k]')
        if (!btn) return
        insertKey(btn.dataset.k)
        $('expr').focus()
      })

      $('expr').addEventListener('input', scheduleRecompute)
      $('expr').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmExpr() }
      })

      async function copyText(text) {
        if (!text) return
        try {
          await api.clipboard.writeText(text)
          toast('已复制 ' + text, 'success')
        } catch (err) {
          toast(String(err?.message || err) || '复制失败', 'error')
        }
      }
      $('btn-copy').onclick = () => { if (current.ok) copyText(current.text) }

      // —— 生命周期：onEnter payload type:'text' 表达式预填 ——
      api?.onEnter?.(({ payload }) => {
        const text =
          payload && typeof payload === 'object' && typeof payload.text === 'string'
            ? payload.text
            : typeof payload === 'string'
              ? payload
              : ''
        if (text) {
          $('expr').value = text
          recompute()
        }
        $('expr').focus()
        $('expr').select()
      })

      api?.ui?.setTitle?.('计算器')
      renderHistory()
      $('expr').focus()
    
