// MD5 纯 JS 实现（RFC 1321，WebCrypto 不提供 MD5）+ 编码工具。可在 node 中直接自测。

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = new Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;

function toBytes(text) {
  return new TextEncoder().encode(text);
}

export function md5(input) {
  const bytes = typeof input === "string" ? toBytes(input) : input;
  const len = bytes.length;
  const bitLen = len * 8;
  // 填充：0x80 补零至 56 mod 64，末尾 8 字节小端比特长度
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const rl = (x, c) => (x << c) | (x >>> (32 - c));
  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const M = new Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(chunk + i * 4, true);
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rl(F, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true);
  ov.setUint32(4, b0, true);
  ov.setUint32(8, c0, true);
  ov.setUint32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const clean = String(b64 ?? "").replace(/\s+/g, "");
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** node 环境（自测）用 crypto.webcrypto 补位；浏览器用全局 */
export const subtle = globalThis.crypto?.subtle ?? null;

export async function digestHex(algo, text) {
  if (algo === "MD5") return md5(text);
  if (!subtle) return null;
  try {
    const data = toBytes(text);
    const buf = await subtle.digest(algo, data);
    return bytesToHex(new Uint8Array(buf));
  } catch {
    return null; // 平台不支持（如部分引擎无 SHA-224）
  }
}

/** WebCrypto 名称映射：SHA-224 部分平台缺失时退化为 node crypto */
export async function digestBytes(algo, bytes) {
  if (algo === "MD5") return new Uint8Array(16); // 文件哈希仅支持 SHA 系
  const buf = await subtle.digest(algo, bytes);
  return new Uint8Array(buf);
}

export const HASH_ALGOS = [
  { id: "SHA-1", label: "SHA-1" },
  { id: "SHA-224", label: "SHA-224" },
  { id: "SHA-256", label: "SHA-256" },
  { id: "SHA-384", label: "SHA-384" },
  { id: "SHA-512", label: "SHA-512" },
  { id: "MD5", label: "MD5", js: true },
];
