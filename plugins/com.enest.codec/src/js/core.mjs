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
export const MODES = {
  base64: "Base64",
  base64url: "Base64URL",
  url: "URL",
  hex: "Hex",
  unicode: "Unicode",
  html: "HTML 实体",
  jwt: "JWT 查看",
  query: "URL 参数",
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
  throw new Error("未知编解码模式");
}
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
