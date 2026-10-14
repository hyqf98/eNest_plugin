// JWT 三段式解码（不验签）。可在 node 中直接自测。

function base64UrlDecode(segment) {
  const b64 = String(segment ?? "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(padded);
}

/** 解析 JWT：header/payload JSON + 原样签名；非法结构抛错 */
export function decodeJwt(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3) throw new Error(`JWT 应为三段式（header.payload.signature），实际 ${parts.length} 段`);
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(Uint8Array.from(base64UrlDecode(h), (c) => c.charCodeAt(0))));
  } catch {
    throw new Error("header 不是合法的 base64url JSON");
  }
  try {
    payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(base64UrlDecode(p), (c) => c.charCodeAt(0))));
  } catch {
    throw new Error("payload 不是合法的 base64url JSON");
  }
  if (!header || typeof header !== "object") throw new Error("header 解析后不是 JSON 对象");
  return { header, payload, signature: s };
}

/** 时间字段人性化：exp/iat/nbf → 可读时间 */
export function annotateTimes(payload, now = Date.now()) {
  const out = {};
  for (const key of ["exp", "iat", "nbf"]) {
    if (typeof payload?.[key] === "number") {
      const ms = payload[key] * 1000;
      const state = key === "exp" ? (ms < now ? "（已过期）" : "（未过期）") : ms > now ? "（未生效）" : "";
      out[key] = `${new Date(ms).toISOString()}${state}`;
    }
  }
  return out;
}
