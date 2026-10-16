/**
 * 哈希与加密主界面 —— React 版（原 src/js/main.js 命令式逻辑等价迁移）
 * DOM 结构 / 类名 / id 与原 index.html 完全一致，样式零改变；
 * 业务核心 md5.mjs / jwt.mjs（含 WebCrypto 调用）原样复用，未改动。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { bindFileInput, readDroppedFiles } from '@enest/plugin-kit/file-inputs'
import {
  md5, bytesToHex, bytesToBase64, base64ToBytes,
  HASH_ALGOS, subtle,
  compareDigest, normalizeDigest,
} from '../js/md5.mjs'
import { decodeJwt, annotateTimes } from '../js/jwt.mjs'
import { Select } from '../ui/index.jsx'

const api = window.enest || window.zapi
const ENC_KEY = 'hash_encoding_v1'
const RSA_KEY_REF = 'rsa_keypair_b64_v1'

const HMAC_ALGS = [
  { value: 'SHA-256', label: 'HMAC-SHA-256' },
  { value: 'SHA-1', label: 'HMAC-SHA-1' },
  { value: 'SHA-384', label: 'HMAC-SHA-384' },
  { value: 'SHA-512', label: 'HMAC-SHA-512' },
]

function hexToBytes(hex) {
  return Uint8Array.from(String(hex).match(/.{2}/g) || [], (v) => parseInt(v, 16))
}

function randomB64(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return bytesToBase64(bytes)
}

function frame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function readAuthorizedBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('无法读取文件内容'))
    reader.readAsArrayBuffer(file)
  })
}

function sizeLabel(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B'
}

/** 期望值分段：首个差异位前后分色（等价原 segmentsOf） */
function segmentsOf(actualHex, expectedText) {
  const actual = String(actualHex ?? '').toLowerCase()
  const { value: expected } = normalizeDigest(expectedText)
  const verdict = compareDigest(actual, expected)
  if (verdict.equal) return [{ text: expected, same: true }]
  const at = Math.max(0, verdict.mismatch)
  const segs = []
  if (at > 0) segs.push({ text: expected.slice(0, at), same: true })
  segs.push({ text: expected.slice(at), same: false })
  return segs
}

export function App() {
  const kitRef = useRef(null)
  const fileInputRef = useRef(null)
  const cleanupFileInputRef = useRef(null)

  /* —— 哈希区状态 —— */
  const [hashText, setHashText] = useState('')
  const [hashValues, setHashValues] = useState(() => Object.fromEntries(HASH_ALGOS.map((a) => [a.id, { value: '', empty: true }])))
  const [encoding, setEncoding] = useState('hex')
  const [tab, setTab] = useState('hash')
  const [fileResult, setFileResult] = useState(null) // { html } | { text } | null
  const [dropBusy, setDropBusy] = useState(false)
  const [dragover, setDragover] = useState(false)
  const [progress, setProgress] = useState(null) // 0~1 | null
  const [fileLabel, setFileLabel] = useState('拖入文件或点击选择 · 计算 SHA-256')
  const [verifyInput, setVerifyInput] = useState('')

  /* —— 加密区状态 —— */
  const [hmacAlg, setHmacAlg] = useState('SHA-256')
  const [hmacKey, setHmacKey] = useState('')
  const [hmacOut, setHmacOut] = useState('')
  const [aesKey, setAesKey] = useState('')
  const [aesIv, setAesIv] = useState('')
  const [aesText, setAesText] = useState('')
  const [aesOut, setAesOut] = useState('')
  const [aesError, setAesError] = useState('')
  const [rsaStatus, setRsaStatus] = useState('尚未生成密钥对')
  const [rsaText, setRsaText] = useState('')
  const [rsaOut, setRsaOut] = useState('')
  const [rsaError, setRsaError] = useState('')
  const [rsaReady, setRsaReady] = useState(false)
  const [randomOut, setRandomOut] = useState('')

  /* —— JWT 区状态 —— */
  const [jwtInput, setJwtInput] = useState('')
  const [jwtError, setJwtError] = useState('')
  const [jwtParts, setJwtParts] = useState({ header: '', payload: '', signature: '' })

  /* —— ref 桥接的命令式状态（编码/文件摘要/输出暂存） —— */
  const encodingRef = useRef('hex')
  encodingRef.current = encoding
  const fileDigestHexRef = useRef('') // 最近一次文件 SHA-256，供「校验对比」直连
  const lastPrimaryHexRef = useRef('') // 文本输入的 SHA-256（hex 基准，供对比）
  const lastOutputRef = useRef({ hmac: '', aes: '', rsa: '', random: '' })
  const rsaKeysRef = useRef(null)
  const lastSignatureB64Ref = useRef('')
  const hmacAlgRef = useRef('SHA-256')
  hmacAlgRef.current = hmacAlg
  const hmacKeyRef = useRef('')
  hmacKeyRef.current = hmacKey

  const toast = useCallback((message, type) => kitRef.current?.toast(message, type), [])
  const copy = useCallback((value) => kitRef.current?.copy(value).catch((err) => kitRef.current?.toast(err.message, 'error')), [])

  /* ── 哈希计算（等价原 computeHash/hexOf） ── */
  const computeHash = useCallback(async (algo, text) => {
    if (!text) return null
    const enc = encodingRef.current
    if (algo === 'MD5') return enc === 'hex' ? md5(text) : bytesToBase64(hexToBytes(md5(text)))
    try {
      const buf = await subtle.digest(algo, new TextEncoder().encode(text))
      return enc === 'hex' ? bytesToHex(new Uint8Array(buf)) : bytesToBase64(new Uint8Array(buf))
    } catch {
      return null // 平台不支持（如部分引擎无 SHA-224）
    }
  }, [])

  const hexOf = useCallback(async (algo, text) => {
    if (algo === 'MD5') return md5(text)
    try {
      const buf = await subtle.digest(algo, new TextEncoder().encode(text))
      return bytesToHex(new Uint8Array(buf))
    } catch {
      return ''
    }
  }, [])

  /* —— 校验对比（等价原 runVerify，输出 JSX 版 DOM 结构一致） —— */
  const verify = useCallback(() => {
    const expected = verifyInput.trim()
    const lastPrimaryHex = lastPrimaryHexRef.current
    if (!expected || !lastPrimaryHex) return null
    const verdict = compareDigest(lastPrimaryHex, expected)
    if (verdict.invalid) {
      return { badge: 'pk-badge pk-badge-warn', badgeText: '期望值不是十六进制', diff: null }
    }
    if (verdict.equal) {
      return { badge: 'pk-badge pk-badge-ok', badgeText: '校验一致', diff: null }
    }
    return {
      badge: 'pk-badge pk-badge-danger',
      badgeText: '校验不一致',
      diff: {
        prefix: ' 首个差异在第 ' + (verdict.mismatch + 1) + ' 位：',
        segments: segmentsOf(lastPrimaryHex, expected),
      },
    }
  }, [verifyInput])
  const verdict = verify()

  /* —— 输入即算：六算法并行 + 校验基准更新（等价原 renderHashes） —— */
  useEffect(() => {
    let alive = true
    const timer = setTimeout(async () => {
      const text = hashText
      const next = {}
      for (const algo of HASH_ALGOS) {
        const value = await computeHash(algo.id, text)
        if (!alive) return
        next[algo.id] = { value: value || '—', empty: !value }
      }
      setHashValues(next)
      // 校验对比基准：文本输入时取 SHA-256 hex；文件哈希刚算完时保持 fileDigestHex
      if (text) lastPrimaryHexRef.current = await hexOf('SHA-256', text)
      else if (!fileDigestHexRef.current) lastPrimaryHexRef.current = ''
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [hashText, encoding, computeHash, hexOf])

  /* ── 文件哈希：SHA-256 + SHA-1 + MD5 并行，进度反馈（等价原 hashFile） ── */
  const hashFile = useCallback(async (file) => {
    if (file.size > 32 * 1024 * 1024) {
      setFileResult({ text: `${file.name} 超过 32MB，请取内容片段计算` })
      kitRef.current?.toast('文件超过 32MB', 'error')
      return
    }
    setDropBusy(true)
    setFileLabel(`正在读取 ${file.name}（${sizeLabel(file.size)}）…`)
    setFileResult(null)
    setProgress(0.15)
    try {
      // 读取分两段，给大文件一个可见的进行中状态，避免长任务无反馈
      await frame()
      const buf = file.arrayBuffer ? await file.arrayBuffer() : await readAuthorizedBuffer(file)
      setProgress(0.6)
      await frame()
      const bytes = new Uint8Array(buf)
      const [sha256, sha1, digest5] = await Promise.all([
        subtle.digest('SHA-256', bytes).catch(() => null),
        subtle.digest('SHA-1', bytes).catch(() => null),
        Promise.resolve(md5(bytes)),
      ])
      setProgress(1)
      fileDigestHexRef.current = sha256 ? bytesToHex(new Uint8Array(sha256)) : ''
      lastPrimaryHexRef.current = fileDigestHexRef.current || lastPrimaryHexRef.current
      setFileResult({
        html: {
          name: file.name,
          size: sizeLabel(file.size),
          sha256: sha256 ? bytesToHex(new Uint8Array(sha256)) : null,
          sha1: sha1 ? bytesToHex(new Uint8Array(sha1)) : null,
          md5: digest5,
        },
      })
      if (fileDigestHexRef.current) {
        kitRef.current?.copy(fileDigestHexRef.current).catch(() => {})
        kitRef.current?.toast('SHA-256 已算出并复制', 'success')
      }
    } catch (e) {
      setFileResult({ text: '读取失败：' + e.message })
    } finally {
      setDropBusy(false)
      setProgress(null)
      setFileLabel('拖入文件或点击选择 · 计算 SHA-256 / SHA-1 / MD5')
    }
  }, [])

  /* ── HMAC（等价原 runHmac，150ms 防抖） ── */
  useEffect(() => {
    let alive = true
    const timer = setTimeout(async () => {
      const text = hashText
      const key = hmacKeyRef.current
      if (!text || !key || !subtle) {
        if (alive) setHmacOut(text ? '需要密钥' : '')
        return
      }
      try {
        const cryptoKey = await subtle.importKey(
          'raw',
          new TextEncoder().encode(key),
          { name: 'HMAC', hash: hmacAlgRef.current },
          false,
          ['sign'],
        )
        const sig = await subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(text))
        const bytes = new Uint8Array(sig)
        if (!alive) return
        lastOutputRef.current.hmac = encodingRef.current === 'hex' ? bytesToHex(bytes) : bytesToBase64(bytes)
        setHmacOut(lastOutputRef.current.hmac)
      } catch (e) {
        if (alive) setHmacOut('HMAC 失败：' + e.message)
      }
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [hashText, hmacKey, hmacAlg])

  /* ── JWT（等价原 renderJwt，200ms 防抖） ── */
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      if (!alive) return
      setJwtError('')
      const token = jwtInput.trim()
      if (!token) {
        setJwtParts({ header: '', payload: '', signature: '' })
        return
      }
      try {
        const { header, payload, signature } = decodeJwt(token)
        const times = annotateTimes(payload)
        setJwtParts({
          header: JSON.stringify(header, null, 2),
          payload: JSON.stringify({ ...payload, ...times }, null, 2),
          signature: signature || '（空）',
        })
      } catch (e) {
        setJwtError(e.message)
      }
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [jwtInput])

  /* ── RSA 密钥恢复（等价原 restoreRsaKeys） ── */
  const restoreRsaKeys = useCallback(async () => {
    try {
      const saved = await kitRef.current?.load(RSA_KEY_REF, null)
      if (!saved?.private || !saved?.public || !subtle) return
      const priv = await subtle.importKey(
        'pkcs8',
        base64ToBytes(saved.private),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        true,
        ['decrypt'],
      )
      const pub = await subtle.importKey(
        'spki',
        base64ToBytes(saved.public),
        { name: 'RSA-OAEP', hash: 'SHA-256' },
        true,
        ['encrypt'],
      )
      rsaKeysRef.current = { privateKey: priv, publicKey: pub }
      setRsaStatus('已恢复上次密钥对')
      setRsaReady(true)
    } catch {
      /* 忽略损坏的密钥 */
    }
  }, [])

  /* ── 宿主适配器：quick 查询 / 动作（latest-ref 桥接，PluginKit.create 仅一次） ── */
  const stateRef = useRef({})
  stateRef.current = { setHashText: (v) => { setHashText(v) } }

  useEffect(() => {
    const kit = PluginKit.create({
      title: '哈希与加密',
      quickPlaceholder: '输入即算：SHA-1/224/256/384/512 · MD5',
      height: 460,
      defaults: { encoding: 'hex', hmacAlg: 'SHA-256' },
      onQuery: (value) => {
        stateRef.current.onQuery?.(value)
      },
      onAction: (action) => {
        if (action === 'clear') stateRef.current.onClear?.()
      },
    })
    kitRef.current = kit

    // 隐藏原生 file input 的宿主选择器接管（等价原 bindFileInput）
    if (fileInputRef.current) {
      cleanupFileInputRef.current = bindFileInput(fileInputRef.current, {
        api,
        onError: (error) => kit.toast(error.message, 'error'),
      })
    }

    let alive = true
    void (async () => {
      await kit.ready
      if (!alive) return
      const enc = kit.settings.encoding === 'base64' ? 'base64' : 'hex'
      encodingRef.current = enc
      setEncoding(enc)
      if (kit.settings.hmacAlg && ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'].includes(kit.settings.hmacAlg))
        setHmacAlg(kit.settings.hmacAlg)
      await restoreRsaKeys()
      stateRef.current.onQuery?.(kit.query || '')
    })()
    return () => {
      alive = false
      cleanupFileInputRef.current?.()
    }
  }, [restoreRsaKeys])

  /* onQuery/onAction 实际行为挂到 latest ref（设置 hashText 并触发重算） */
  useEffect(() => {
    stateRef.current.onQuery = (value) => setHashText(String(value))
    stateRef.current.onClear = () => setHashText('')
  })

  /* ── quick 高度自适应（等价原 reportHeight + ResizeObserver） ── */
  const lastHeightRef = useRef(0)
  useEffect(() => {
    const reportHeight = () => {
      const kit = kitRef.current
      if (!kit || kit.mode !== 'quick') return
      const height = Math.min(640, Math.max(320, document.body.scrollHeight))
      if (Math.abs(height - lastHeightRef.current) < 24) return
      lastHeightRef.current = height
      void api?.ui?.setHeight?.(height)
    }
    const observer = new ResizeObserver(reportHeight)
    observer.observe(document.body)
    reportHeight()
    return () => observer.disconnect()
  }, [])

  /* ── AES-GCM（等价原加解密逻辑） ── */
  const getAesKey = async () => {
    const b64 = aesKey.trim()
    if (!b64) throw new Error('请先生成或粘贴 AES 密钥')
    const raw = base64ToBytes(b64)
    if (![16, 24, 32].includes(raw.length)) throw new Error(`AES 密钥须为 16/24/32 字节，当前 ${raw.length} 字节`)
    return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  const getAesIv = async () => {
    const b64 = aesIv.trim()
    if (!b64) throw new Error('请先生成或粘贴 IV')
    const iv = base64ToBytes(b64)
    if (iv.length !== 12) throw new Error(`GCM IV 须为 12 字节，当前 ${iv.length} 字节`)
    return iv
  }
  const aesEncrypt = async () => {
    setAesError('')
    try {
      const key = await getAesKey()
      const iv = await getAesIv()
      const plain = aesText
      if (!plain) throw new Error('明文为空')
      const buf = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain))
      lastOutputRef.current.aes = bytesToBase64(new Uint8Array(buf))
      setAesOut(lastOutputRef.current.aes)
    } catch (e) {
      setAesError(e.message)
    }
  }
  const aesDecrypt = async () => {
    setAesError('')
    try {
      const key = await getAesKey()
      const iv = await getAesIv()
      const cipher = base64ToBytes(aesText)
      const buf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)
      lastOutputRef.current.aes = new TextDecoder().decode(buf)
      setAesOut(lastOutputRef.current.aes)
    } catch (e) {
      setAesError('解密失败：' + e.message)
    }
  }

  /* ── RSA-OAEP / RSA-PSS（等价原生成/加解密/签名验签） ── */
  const exportB64 = async (key, type) => {
    const data = type === 'pkcs8' ? await subtle.exportKey('pkcs8', key) : await subtle.exportKey('spki', key)
    return bytesToBase64(new Uint8Array(data))
  }
  const rsaGen = async () => {
    setRsaStatus('生成中…')
    try {
      const pair = await subtle.generateKey(
        { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['encrypt', 'decrypt'],
      )
      const sigPair = await subtle.generateKey(
        { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )
      rsaKeysRef.current = { privateKey: pair.privateKey, publicKey: pair.publicKey, signKey: sigPair.privateKey, verifyKey: sigPair.publicKey }
      const dump = {
        private: await exportB64(pair.privateKey, 'pkcs8'),
        public: await exportB64(pair.publicKey, 'spki'),
      }
      await kitRef.current?.save(RSA_KEY_REF, dump)
      setRsaStatus(`密钥对已生成并持久化 · 公钥 ${dump.public.length} 字符`)
      setRsaReady(true)
    } catch (e) {
      setRsaStatus('')
      toast('RSA 生成失败：' + e.message, 'error')
    }
  }
  const rsaEncrypt = async () => {
    setRsaError('')
    try {
      const buf = await subtle.encrypt({ name: 'RSA-OAEP' }, rsaKeysRef.current.publicKey, new TextEncoder().encode(rsaText))
      lastOutputRef.current.rsa = bytesToBase64(new Uint8Array(buf))
      setRsaOut(lastOutputRef.current.rsa)
    } catch (e) {
      setRsaError('加密失败：' + e.message)
    }
  }
  const rsaDecrypt = async () => {
    setRsaError('')
    try {
      const buf = await subtle.decrypt({ name: 'RSA-OAEP' }, rsaKeysRef.current.privateKey, base64ToBytes(rsaText))
      lastOutputRef.current.rsa = new TextDecoder().decode(buf)
      setRsaOut(lastOutputRef.current.rsa)
    } catch (e) {
      setRsaError('解密失败：' + e.message)
    }
  }
  // PSS 签名输入为明文，签名为 base64；验签时把明文与 base64 签名分别传入
  const rsaSign = async () => {
    setRsaError('')
    try {
      const buf = await subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, rsaKeysRef.current.signKey, new TextEncoder().encode(rsaText))
      lastSignatureB64Ref.current = bytesToBase64(new Uint8Array(buf))
      lastOutputRef.current.rsa = lastSignatureB64Ref.current
      setRsaOut(lastOutputRef.current.rsa)
    } catch (e) {
      setRsaError('签名失败：' + e.message)
    }
  }
  const rsaVerify = async () => {
    setRsaError('')
    try {
      const input = rsaText.trim()
      const signature = base64ToBytes(lastSignatureB64Ref.current || input)
      const data = new TextEncoder().encode(lastSignatureB64Ref.current ? rsaText : '')
      if (!lastSignatureB64Ref.current && !input) throw new Error('没有可验证的签名')
      const ok = await subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, rsaKeysRef.current.verifyKey, signature, data)
      toast(ok ? '验签通过' : '验签失败：签名不匹配', ok ? 'success' : 'error')
    } catch (e) {
      toast('验签失败：' + e.message, 'error')
    }
  }

  /* —— 渲染辅助 —— */
  const sha256Value = hashValues['SHA-256']?.value
  const verifyCopyDisabled = !lastPrimaryHexRef.current
  const hmacCopyDisabled = !hmacOut
  const randomCopyDisabled = !randomOut

  const pasteHash = async () => {
    try {
      setHashText(String((await api.clipboard.readText()) ?? ''))
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const onDrop = async (e) => {
    setDragover(false)
    e.preventDefault()
    try {
      const [file] = await readDroppedFiles(e.dataTransfer?.files, { api })
      if (file) await hashFile(file)
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  return (
    <main className="hash-app">
      <header className="topbar">
        <nav className="tabs" role="tablist" aria-label="功能区">
          <button role="tab" id="tab-hash" aria-selected={tab === 'hash'} onClick={() => setTab('hash')}>哈希</button>
          <button role="tab" id="tab-crypto" aria-selected={tab === 'crypto'} onClick={() => setTab('crypto')}>加密</button>
          <button role="tab" id="tab-jwt" aria-selected={tab === 'jwt'} onClick={() => setTab('jwt')}>JWT</button>
        </nav>
        <div className="spacer"></div>
        <div className="encoding segmented" id="encoding-row" role="group" aria-label="输出编码">
          <button
            id="enc-hex"
            className={encoding === 'hex' ? 'active' : undefined}
            aria-pressed={encoding === 'hex'}
            onClick={async () => {
              encodingRef.current = 'hex'
              setEncoding('hex')
              try { await kitRef.current?.save(ENC_KEY, 'hex') } catch { /* 忽略 */ }
            }}
          >HEX</button>
          <button
            id="enc-base64"
            className={encoding === 'base64' ? 'active' : undefined}
            aria-pressed={encoding === 'base64'}
            onClick={async () => {
              encodingRef.current = 'base64'
              setEncoding('base64')
              try { await kitRef.current?.save(ENC_KEY, 'base64') } catch { /* 忽略 */ }
            }}
          >Base64</button>
        </div>
      </header>

      {/* ── 哈希区 ─────────────────────── */}
      <section className="page" id="page-hash" role="tabpanel" aria-labelledby="tab-hash" hidden={tab !== 'hash'}>
        <div className="field">
          <div className="field-head">
            <label htmlFor="hash-input">输入内容</label>
            <span className="field-actions">
              <button id="hash-paste" onClick={pasteHash}>粘贴</button>
              <button id="hash-clear" onClick={() => setHashText('')}>清空</button>
            </span>
          </div>
          <textarea
            id="hash-input" rows="4" spellcheck="false"
            placeholder="输入即算：同屏展示 SHA-1/224/256/384/512 与 MD5"
            value={hashText}
            onChange={(e) => setHashText(e.target.value)}
          />
          <p id="hash-empty" className="empty-state" hidden={!!hashText}>
            <span className="empty-title">输入即算</span>
            在上方粘贴文本，六种算法并行出值；也可以把文件拖进下方虚线框算 SHA-256 摘要，用于校验下载完整性。
          </p>
        </div>

        <section className="hash-file">
          <div
            className={'dropzone' + (dragover ? ' dragover' : '') + (dropBusy ? ' busy' : '')}
            id="hash-drop" tabIndex={0} role="button" aria-label="选择或拖入文件计算 SHA-256"
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                fileInputRef.current?.click()
              }
            }}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes('Files')) {
                e.preventDefault()
                setDragover(true)
              }
            }}
            onDragLeave={() => setDragover(false)}
            onDrop={onDrop}
          >
            <input id="hash-file" type="file" hidden ref={fileInputRef}
              onChange={() => {
                const file = fileInputRef.current?.files?.[0]
                if (file) void hashFile(file)
              }} />
            <span id="hash-file-label">{fileLabel}</span>
            <div className="progress" id="hash-progress" hidden={progress == null}>
              <div className="bar" id="hash-progress-bar" style={progress == null ? undefined : { width: Math.round(progress * 100) + '%' }}></div>
            </div>
          </div>
          <div className="file-result" id="hash-file-result" hidden={!fileResult}>
            {fileResult?.text != null && fileResult.text}
            {fileResult?.html && (
              <>
                <strong>{fileResult.html.name}</strong> · {fileResult.html.size}
                {fileResult.html.sha256 && (<><br />SHA-256 <span className="mono">{fileResult.html.sha256}</span></>)}
                {fileResult.html.sha1 && (<><br />SHA-1 <span className="mono dim">{fileResult.html.sha1}</span></>)}
                <br />MD5 <span className="mono dim">{fileResult.html.md5}</span>
              </>
            )}
          </div>
        </section>

        <ul className="hash-grid" id="hash-list">
          {HASH_ALGOS.map((a) => (
            <li
              key={a.id}
              className="hash-card"
              title={a.js ? '纯 JS 实现（WebCrypto 不提供 MD5）' : a.id === 'SHA-224' ? '部分平台 WebCrypto 不支持 SHA-224，缺失时显示 —' : ''}
            >
              <div className="card-head">
                <span className="algo">{a.label}</span>
                <button
                  data-copy={a.id}
                  className="card-copy"
                  disabled={hashValues[a.id]?.empty}
                  onClick={() => {
                    const value = hashValues[a.id]?.value
                    if (value && !hashValues[a.id]?.empty) copy(value)
                  }}
                >复制</button>
              </div>
              <span className={'value' + (hashValues[a.id]?.empty ? ' empty' : '')} data-algo={a.id}>
                {hashValues[a.id]?.value || '—'}
              </span>
            </li>
          ))}
        </ul>

        <section className="verify">
          <div className="verify-head">
            <label htmlFor="verify-input">校验对比</label>
            <span className="hint">粘贴期望的哈希值，自动逐字符对比</span>
          </div>
          <div className="verify-row">
            <input
              id="verify-input" className="mono" spellcheck="false"
              placeholder="例如 3a985da74fe225b2 04a85f4c…"
              value={verifyInput}
              onChange={(e) => setVerifyInput(e.target.value)}
            />
            <button
              id="verify-copy" className="mono" disabled={verifyCopyDisabled} title="复制当前首个结果"
              onClick={() => {
                const value = sha256Value
                if (value && value !== '—') copy(value)
              }}
            >复制结果</button>
          </div>
          <p id="verify-out" className="verify-out" hidden={!verdict}>
            {verdict && (
              <>
                <span className={verdict.badge}>{verdict.badgeText}</span>
                {verdict.diff && (
                  <>
                    {verdict.diff.prefix}
                    <code className="mono diff">
                      {verdict.diff.segments.map((seg, i) => (
                        <span key={i} className={seg.same ? 'same' : 'diff-bad'}>{seg.text}</span>
                      ))}
                    </code>
                  </>
                )}
              </>
            )}
          </p>
        </section>
      </section>

      {/* ── 加密区 ─────────────────────── */}
      <section className="page" id="page-crypto" role="tabpanel" aria-labelledby="tab-crypto" hidden={tab !== 'crypto'}>
        <details className="block" open>
          <summary>HMAC 签名 <span className="hint">算法 + 密钥，随哈希输入联动</span></summary>
          <div className="block-body">
            <div className="grid-row">
              <div>
                <label htmlFor="hmac-alg">算法</label>
                <Select
                  id="hmac-alg"
                  ariaLabel="HMAC 算法"
                  value={hmacAlg}
                  options={HMAC_ALGS}
                  onChange={(next) => {
                    setHmacAlg(next)
                    void api.settings.set('hmacAlg', next).catch?.(() => {})
                  }}
                />
              </div>
              <div className="grow">
                <label htmlFor="hmac-key">密钥</label>
                <div className="key-row">
                  <input id="hmac-key" className="mono" spellcheck="false" placeholder="密钥文本"
                    value={hmacKey} onChange={(e) => setHmacKey(e.target.value)} />
                  <button id="hmac-gen-key" title="生成 32 字节随机密钥（base64）"
                    onClick={() => setHmacKey(randomB64(32))}>随机</button>
                </div>
              </div>
            </div>
            <div className="result-row">
              <output id="hmac-out" className="mono">{hmacOut}</output>
              <button id="hmac-copy" disabled={hmacCopyDisabled} onClick={() => copy(lastOutputRef.current.hmac)}>复制</button>
            </div>
          </div>
        </details>

        <details className="block" open>
          <summary>AES-GCM <span className="hint">密钥 / IV 生成，base64 出入</span></summary>
          <div className="block-body">
            <div className="grid-row">
              <div className="grow">
                <label htmlFor="aes-key">密钥（base64，16/24/32 字节）</label>
                <div className="key-row">
                  <input id="aes-key" className="mono" spellcheck="false" placeholder="留空则点击生成"
                    value={aesKey} onChange={(e) => setAesKey(e.target.value)} />
                  <button id="aes-gen-key" onClick={() => { setAesKey(randomB64(32)); setAesError('') }}>生成密钥</button>
                </div>
              </div>
              <div className="grow">
                <label htmlFor="aes-iv">IV（base64，12 字节）</label>
                <div className="key-row">
                  <input id="aes-iv" className="mono" spellcheck="false" placeholder="留空则点击生成"
                    value={aesIv} onChange={(e) => setAesIv(e.target.value)} />
                  <button id="aes-gen-iv" onClick={() => setAesIv(randomB64(12))}>生成 IV</button>
                </div>
              </div>
            </div>
            <div className="field">
              <label htmlFor="aes-text">明文 / 密文（base64）</label>
              <textarea id="aes-text" rows="3" className="mono" spellcheck="false"
                placeholder="加密时输入明文；解密时粘贴 base64 密文"
                value={aesText} onChange={(e) => setAesText(e.target.value)} />
            </div>
            <div className="result-row">
              <output id="aes-out" className="mono">{aesOut}</output>
              <button id="aes-encrypt" onClick={aesEncrypt}>加密</button>
              <button id="aes-decrypt" onClick={aesDecrypt}>解密</button>
              <button id="aes-copy" disabled={!aesOut} onClick={() => copy(lastOutputRef.current.aes)}>复制</button>
            </div>
            <p id="aes-error" className="error-bar" role="alert" hidden={!aesError}>{aesError}</p>
          </div>
        </details>

        <details className="block">
          <summary>RSA-OAEP / RSA-PSS <span className="hint">2048 位密钥对，签名验签</span></summary>
          <div className="block-body">
            <div className="result-row">
              <span className="hint" id="rsa-status">{rsaStatus}</span>
              <span className="spacer"></span>
              <button id="rsa-gen" onClick={rsaGen}>生成密钥对（2048）</button>
            </div>
            <div className="field">
              <label htmlFor="rsa-text">明文 / 密文（base64）</label>
              <textarea id="rsa-text" rows="2" className="mono" spellcheck="false"
                placeholder="公钥加密明文；私钥解密 base64 密文"
                value={rsaText} onChange={(e) => setRsaText(e.target.value)} />
            </div>
            <div className="result-row">
              <output id="rsa-out" className="mono">{rsaOut}</output>
              <button id="rsa-encrypt" disabled={!rsaReady} onClick={rsaEncrypt}>公钥加密</button>
              <button id="rsa-decrypt" disabled={!rsaReady} onClick={rsaDecrypt}>私钥解密</button>
              <button id="rsa-sign" disabled={!rsaReady} onClick={rsaSign}>私钥签名</button>
              <button id="rsa-verify" disabled={!rsaReady} onClick={rsaVerify}>公钥验签</button>
              <button id="rsa-copy" disabled={!rsaReady || !rsaOut} onClick={() => copy(lastOutputRef.current.rsa)}>复制</button>
            </div>
            <p id="rsa-error" className="error-bar" role="alert" hidden={!rsaError}>{rsaError}</p>
          </div>
        </details>

        <div className="utils">
          <button id="gen-random" onClick={() => { lastOutputRef.current.random = randomB64(16); setRandomOut(lastOutputRef.current.random) }}>随机盐 / IV 生成器</button>
          <output id="random-out" className="mono">{randomOut}</output>
          <button id="random-copy" disabled={randomCopyDisabled} onClick={() => copy(lastOutputRef.current.random)}>复制</button>
        </div>
      </section>

      {/* ── JWT 区 ─────────────────────── */}
      <section className="page" id="page-jwt" role="tabpanel" aria-labelledby="tab-jwt" hidden={tab !== 'jwt'}>
        <p className="hint jwt-note">仅解码展示 header / payload（不验签）；签名段原样透出。</p>
        <div className="field">
          <label htmlFor="jwt-input">JWT</label>
          <textarea id="jwt-input" rows="4" className="mono" spellcheck="false"
            placeholder="eyJhbGciOi... 粘贴三段式 JWT"
            value={jwtInput} onChange={(e) => setJwtInput(e.target.value)} />
        </div>
        <div id="jwt-error" className="error-bar" role="alert" hidden={!jwtError}>{jwtError}</div>
        <div className="jwt-parts">
          <div className="jwt-part">
            <h2>Header</h2>
            <pre id="jwt-header" className="mono">{jwtParts.header}</pre>
          </div>
          <div className="jwt-part">
            <h2>Payload</h2>
            <pre id="jwt-payload" className="mono">{jwtParts.payload}</pre>
          </div>
          <div className="jwt-part">
            <h2>Signature <span className="hint">不校验</span></h2>
            <pre id="jwt-signature" className="mono">{jwtParts.signature}</pre>
          </div>
        </div>
      </section>
    </main>
  )
}
