/**
 * fucnm 修改器服务的协议加密：凯撒 +3、AES-128-CBC（PKCS7，base64）、MD5 签名、RSA 公钥加密。
 * 这些密钥只用于数据源协议混淆，不是用户凭据。
 */

import { createCipheriv, createDecipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto'
import { fail } from './adapters/types.ts'

/** fucnm 协议 AES key（"fG3EOofuLoNSaGwH"） */
const AES_KEY = Buffer.from('fG3EOofuLoNSaGwH', 'utf8')
/** fucnm 协议 AES iv（"ly7nED38zqFHGlni"） */
const AES_IV = Buffer.from('ly7nED38zqFHGlni', 'utf8')
/** fucnm 签名盐 */
const SIGN_SECRET = 'oPsmWeddKJyMvIk8mv'

/** 凯撒 +3（仅 ASCII 字母，大小写各自循环）；ode 数据源的 EData 参数体混淆 */
export function caesar3(input: string): string {
  let out = ''
  for (const char of input) {
    const code = char.charCodeAt(0)
    if (code >= 65 && code <= 90) out += String.fromCharCode(((code - 65 + 3) % 26) + 65)
    else if (code >= 97 && code <= 122) out += String.fromCharCode(((code - 97 + 3) % 26) + 97)
    else out += char
  }
  return out
}

/** AES-128-CBC 解密（PKCS7，输入 base64）；空串原样返回 */
export function aesDecrypt(encryptedBase64: string): string {
  if (!encryptedBase64) return ''
  let ciphertext: Buffer
  try {
    ciphertext = Buffer.from(encryptedBase64, 'base64')
  } catch {
    fail('DECODE_FAILED', '数据解密失败（base64 无效）')
  }
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) fail('DECODE_FAILED', '数据解密失败（长度不是块的整数倍）')
  const decipher = createDecipheriv('aes-128-cbc', AES_KEY, AES_IV)
  decipher.setAutoPadding(true)
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    fail('DECODE_FAILED', '数据解密失败（填充校验不通过）')
  }
}

/** AES-128-CBC 加密（PKCS7，输出 base64）；空串原样返回 */
export function aesEncrypt(plain: string): string {
  if (!plain) return ''
  const cipher = createCipheriv('aes-128-cbc', AES_KEY, AES_IV)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64')
}

/** 小写十六进制 MD5 */
export function md5Hex(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

/** 当前秒级时间戳文本 */
export function timestampFromSeconds(): string {
  return Math.floor(Date.now() / 1000).toString()
}

/** 生成 nonce：8 个 4 位十六进制段拼接（32 字符） */
export function generateNonce(): string {
  let out = ''
  for (let index = 0; index < 8; index++) out += randomBytes(2).toString('hex').padStart(4, '0')
  return out
}

/** fucnm 攻略接口签名：md5(timestamp + nonce + path + 盐) */
export function fucnmSign(timestamp: string, nonce: string, path: string): string {
  return md5Hex(timestamp + nonce + path + SIGN_SECRET)
}

/**
 * RSA PKCS1 公钥加密，返回密文字节。
 * pem 是 216 字符的 base64 DER 公钥（自动包装成 PEM）。
 */
export function rsaEncryptPkcs1(pem: string, plain: string): Buffer {
  const base64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) fail('LOGIN_FAILED', '登录公钥格式无效')
  const der = Buffer.from(base64, 'base64')
  let key: ReturnType<typeof createPublicKey>
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    fail('LOGIN_FAILED', '登录公钥解析失败')
  }
  try {
    return publicEncrypt({ key, padding: 1 /* RSA_PKCS1_PADDING */ }, Buffer.from(plain, 'utf8'))
  } catch {
    fail('LOGIN_FAILED', '登录数据加密失败')
  }
}

/** 登录编码 A（tickstep 风格）："{RSA}" + base64(hex(密文)) */
export function rsaEncodeTickstep(pem: string, plain: string): string {
  return '{RSA}' + rsaEncryptPkcs1(pem, plain).toString('hex').toUpperCase()
}

/** 登录编码 B（gowsp 风格）："{RSA}" + hex(base64(密文)) */
export function rsaEncodeGowsp(pem: string, plain: string): string {
  return '{RSA}' + Buffer.from(rsaEncryptPkcs1(pem, plain).toString('base64'), 'utf8').toString('hex').toUpperCase()
}
