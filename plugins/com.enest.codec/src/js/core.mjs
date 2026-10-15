const encoder = new TextEncoder();
export function encodeBase64(text, url = false) {
  let binary = "";
  const bytes = encoder.encode(text);
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const value = btoa(binary);
  return url
    ? value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
    : value;
}
export function decodeBase64(text, url = false, strict = true) {
  let input = text.replace(/\s/g, "");
  if (url) {
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(input))
      throw new Error("不是合法的 Base64URL");
    input = input.replaceAll("-", "+").replaceAll("_", "/");
  } else if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input))
    throw new Error("不是合法的 Base64");
  if (input.replace(/=+$/, "").length % 4 === 1)
    throw new Error("Base64 长度不正确");
  if (input.includes("=") && input.length % 4 !== 0)
    throw new Error("Base64 填充不正确");
  input += "=".repeat((4 - (input.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: strict }).decode(bytes);
}
function unicodeDecode(text) {
  if (/\\u(?![0-9a-f]{4}|\{[0-9a-f]{1,6}\})/i.test(text))
    throw new Error("Unicode 转义不完整");
  const result = text.replace(
    /\\u(?:\{([0-9a-f]{1,6})\}|([0-9a-f]{4}))/gi,
    (_, cp, hex) => {
      const n = parseInt(cp || hex, 16);
      if (n > 0x10ffff) throw new Error("Unicode 码点超出范围");
      return cp ? String.fromCodePoint(n) : String.fromCharCode(n);
    },
  );
  if (result.isWellFormed && !result.isWellFormed())
    throw new Error("Unicode 代理对不完整");
  return result;
}
/** 文件字节 → Data URL（base64）。可在 node 中直接自测。 */
export function encodeDataUrl(bytes, mime = "application/octet-stream") {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000)
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return `data:${mime || "application/octet-stream"};base64,${btoa(binary)}`;
}

/** 解析 Data URL：返回 mime、是否 base64、字节大小；非 base64（URL 编码）时返回解码文本。 */
export function parseDataUrl(text) {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(String(text ?? "").trim());
  if (!match) throw new Error("不是合法的 Data URL（data:类型;base64,内容）");
  const mime = match[1] || "text/plain";
  const params = match[2].split(";").slice(1).map((p) => p.trim().toLowerCase());
  if (!params.includes("base64")) {
    const decoded = decodeURIComponent(match[3]);
    return { mime, base64: false, size: encoder.encode(decoded).length, text: decoded };
  }
  const clean = match[3].replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("Data URL 的 base64 段不合法");
  const binary = atob(clean);
  return { mime, base64: true, size: binary.length };
}

const MIME_EXTS = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/svg+xml": "svg", "text/plain": "txt", "application/json": "json",
  "application/pdf": "pdf", "audio/mpeg": "mp3", "video/mp4": "mp4", "application/zip": "zip",
};
const EXT_MIMES = Object.fromEntries(Object.entries(MIME_EXTS).map(([m, e]) => [e, m]));

/** Data URL 保存时的默认扩展名（未知类型回落 bin）。 */
export function mimeToExt(mime) {
  if (MIME_EXTS[mime]) return MIME_EXTS[mime];
  const short = String(mime ?? "").split("/")[1];
  return short && /^[a-z0-9]{1,8}$/i.test(short) ? short : "bin";
}

/** 按文件扩展名推断常见 MIME；未知回落 application/octet-stream。 */
export function guessMime(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(String(name ?? "").trim())?.[1]?.toLowerCase();
  return (ext && EXT_MIMES[ext]) || "application/octet-stream";
}

export const MODES = {
  base64: "Base64",
  base64url: "Base64URL",
  url: "URL",
  hex: "Hex",
  unicode: "Unicode",
  html: "HTML 实体",
  jwt: "JWT 查看",
  query: "URL 参数",
  dataurl: "Data URL",
};
export function convert(
  text,
  mode,
  direction = "encode",
  { strictUtf8 = true } = {},
) {
  const decode = direction === "decode";
  if (encoder.encode(text).length > 2 * 1024 * 1024)
    throw new Error("单次最多处理 2 MB 文本");
  if (mode === "base64" || mode === "base64url")
    return decode
      ? decodeBase64(text, mode === "base64url", strictUtf8)
      : encodeBase64(text, mode === "base64url");
  if (mode === "url")
    return decode ? decodeURIComponent(text) : encodeURIComponent(text);
  if (mode === "hex") {
    if (!decode)
      return Array.from(encoder.encode(text), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const value = text.replace(/^0x/i, "").replace(/\s/g, "");
    if (value.length % 2 || !/^[0-9a-f]*$/i.test(value))
      throw new Error("Hex 需要偶数个十六进制字符");
    return new TextDecoder("utf-8", { fatal: strictUtf8 }).decode(
      Uint8Array.from(value.match(/.{2}/g) || [], (v) => parseInt(v, 16)),
    );
  }
  if (mode === "unicode")
    return decode
      ? unicodeDecode(text)
      : text
          .split("")
          .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
          .join("");
  if (mode === "html") {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    if (!decode) return text.replace(/[&<>"']/g, (c) => entities[c]);
    const named = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: "\u00a0",
    };
    return text.replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (_, entity) => {
        if (!entity.startsWith("#")) return named[entity.toLowerCase()];
        const n =
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        if (
          !Number.isInteger(n) ||
          n < 0 ||
          n > 0x10ffff ||
          (n >= 0xd800 && n <= 0xdfff)
        )
          throw new Error("HTML 实体码点非法");
        return String.fromCodePoint(n);
      },
    );
  }
  if (mode === "jwt") {
    const parts = text.trim().split(".");
    if (parts.length !== 3) throw new Error("JWT 应包含三个以点分隔的部分");
    const header = decodeBase64(parts[0], true),
      payload = decodeBase64(parts[1], true);
    JSON.parse(header);
    JSON.parse(payload);
    return (
      "Header\n" +
      header +
      "\n\nPayload\n" +
      payload +
      "\n\n签名未验证；本工具仅解码查看。"
    );
  }
  if (mode === "query") {
    if (decode) {
      const input = text.trim();
      const query = input.includes("://")
        ? new URL(input).search
        : input.replace(/^\?/, "").split("#")[0];
      return JSON.stringify(
        Array.from(new URLSearchParams(query).entries()),
        null,
        2,
      );
    }
    const pairs = JSON.parse(text);
    if (
      !Array.isArray(pairs) ||
      pairs.some(
        (v) =>
          !Array.isArray(v) ||
          v.length !== 2 ||
          v.some((x) => typeof x !== "string"),
      )
    )
      throw new Error('输入应为 [["键","值"]] 数组；保留重复键');
    return new URLSearchParams(pairs).toString();
  }
  if (mode === "dataurl") {
    if (!decode) {
      // 文本 → Data URL（URL 编码形态，体积小且可读）
      return "data:text/plain;charset=utf-8," + encodeURIComponent(text);
    }
    const info = parseDataUrl(text);
    if (!info.base64)
      return `${info.mime} · ${info.size} B（URL 编码）\n\n${info.text}`;
    return `${info.mime} · ${info.size} B（base64）\n\n头部可另存为 .${mimeToExt(info.mime)} 文件`;
  }
  throw new Error("未知编解码模式");
}
/** 精确定位解码失败位置：返回 { message, index }；无法定位时 index 为 0。 */
export function locateError(text, mode, direction, options) {
  try {
    convert(text, mode, direction, options);
    return null;
  } catch (e) {
    return { message: e.message, index: sniffInvalidIndex(text, mode, direction) };
  }
}

/** 猜测第一个非法字符的位置（仅解码方向的字符级校验，尽力而为）。 */
function sniffInvalidIndex(text, mode, direction) {
  if (direction !== "decode" || typeof text !== "string") return 0;
  if (mode === "hex") {
    const body = text.replace(/^0x/i, "");
    const bad = body.search(/[^0-9a-f\s]/i);
    if (bad !== -1) return bad;
    return 0;
  }
  if (mode === "base64" || mode === "base64url") {
    const alphabet = mode === "base64url" ? /[^A-Za-z0-9_=-]/ : /[^A-Za-z0-9+/=]/;
    const bad = text.search(alphabet);
    return bad === -1 ? 0 : bad;
  }
  return 0;
}

/** 逐行批量转换：每行独立 try/catch，返回 { line, ok, value } 列表。 */
export function convertLines(text, mode, direction, options) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1000) throw new Error("每批最多 1000 行");
  return lines.map((line, i) => {
    try {
      return {
        line: i + 1,
        ok: true,
        value: convert(line, mode, direction, options),
      };
    } catch (e) {
      return { line: i + 1, ok: false, value: e.message };
    }
  });
}

/* ── 最近转换记录（storage 向后兼容：旧值或损坏值一律静默重置）── */
export const HISTORY_KEY = "codec_history_v1";
export const HISTORY_MAX = 24;
export function normalizeHistory(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const rows = [];
  for (const row of source) {
    if (!row || typeof row !== "object") continue;
    if (!MODES[row.mode] || (row.direction !== "encode" && row.direction !== "decode")) continue;
    if (typeof row.text !== "string" || !row.text) continue;
    if (typeof row.at !== "number" || !Number.isFinite(row.at)) continue;
    if (seen.has(row.at + "|" + row.mode + "|" + row.direction + "|" + row.text)) continue;
    seen.add(row.at + "|" + row.mode + "|" + row.direction + "|" + row.text);
    rows.push({ text: row.text.slice(0, 4000), mode: row.mode, direction: row.direction, at: row.at });
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX);
}
export function pushHistory(list, entry) {
  return normalizeHistory([entry, ...normalizeHistory(list)]);
}
export function formatHistoryTime(at, now = Date.now()) {
  const diff = now - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + " 分钟前";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + " 小时前";
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
