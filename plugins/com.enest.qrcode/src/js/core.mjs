const wifiEscape = (value) => String(value).replace(/[\\;,:"']/g, "\\$&");
const cardEscape = (value) =>
  String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r", "");
export function templateText(kind, fields) {
  if (kind === "wifi") {
    if (!fields.ssid?.trim()) throw new Error("请输入 Wi-Fi 名称");
    const security = ["WPA", "WEP", "nopass"].includes(fields.security)
      ? fields.security
      : "WPA";
    return `WIFI:T:${security};S:${wifiEscape(fields.ssid)};${security === "nopass" ? "" : "P:" + wifiEscape(fields.password || "") + ";"}H:${fields.hidden ? "true" : "false"};;`;
  }
  if (kind === "contact") {
    if (!fields.name?.trim()) throw new Error("请输入姓名");
    return [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:" + cardEscape(fields.name),
      fields.phone && "TEL:" + cardEscape(fields.phone),
      fields.email && "EMAIL:" + cardEscape(fields.email),
      fields.company && "ORG:" + cardEscape(fields.company),
      "END:VCARD",
    ]
      .filter(Boolean)
      .join("\r\n");
  }
  if (kind === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email || ""))
      throw new Error("请输入有效邮箱");
    const query = new URLSearchParams();
    if (fields.subject) query.set("subject", fields.subject);
    if (fields.body) query.set("body", fields.body);
    return (
      "mailto:" +
      encodeURIComponent(fields.email).replace("%40", "@") +
      (query.size ? "?" + query.toString().replaceAll("+", "%20") : "")
    );
  }
  return fields.text || "";
}

/** 点样式：square 方点 / dot 圆点 / rounded 圆角点。 */
export const DOT_STYLES = [
  { id: "square", label: "方点" },
  { id: "dot", label: "圆点" },
  { id: "rounded", label: "圆角" },
];

function moduleShape(style, x, y, r) {
  if (style === "dot") return `<circle cx="${x + 0.5}" cy="${y + 0.5}" r="${r}"/>`;
  if (style === "rounded")
    return `<rect x="${x + (1 - r) / 2}" y="${y + (1 - r) / 2}" width="${r}" height="${r}" rx="${r * 0.3}"/>`;
  return `<rect x="${x}" y="${y}" width="1" height="1"/>`;
}

/**
 * canvas 绘制统一走 drawMatrix：返回每个暗模块的绘制参数（方/圆/圆角）。
 * r = 点半径系数（square: 1，rounded: 0.92，dot: 0.5）。
 */
export function dotRadius(style) {
  if (style === "dot") return 0.5;
  if (style === "rounded") return 0.92;
  return 1;
}

/** canvas 逐模块绘制回调：ctx 已设好 fillStyle。 */
export function drawModules(ctx, qr, { scale = 10, margin = 4, style = "square" } = {}) {
  const count = qr.getModuleCount();
  const r = dotRadius(style);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      const x = (col + margin) * scale;
      const y = (row + margin) * scale;
      if (style === "dot") {
        ctx.beginPath();
        ctx.arc(x + scale / 2, y + scale / 2, (scale * r) / 1.0, 0, Math.PI * 2);
        ctx.fill();
      } else if (style === "rounded") {
        const size = scale * r;
        const offset = (scale - size) / 2;
        const radius = size * 0.3;
        ctx.beginPath();
        ctx.moveTo(x + offset + radius, y + offset);
        ctx.arcTo(x + offset + size, y + offset, x + offset + size, y + offset + size, radius);
        ctx.arcTo(x + offset + size, y + offset + size, x + offset, y + offset + size, radius);
        ctx.arcTo(x + offset, y + offset + size, x + offset, y + offset, radius);
        ctx.arcTo(x + offset, y + offset, x + offset + size, y + offset, radius);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(x, y, scale, scale);
      }
    }
  }
}

/**
 * 中心 logo 占位判定：logo 与定位图案重叠会破坏识别，返回 { ok, reason }。
 * logoScale 为 logo 宽度占整码比例（0-0.3），H 级纠错下 ≤0.24 可靠。
 */
export function logoFit(qr, logoScale = 0.2, ecc = "M") {
  const ratio = Math.max(0, Math.min(0.5, Number(logoScale) || 0));
  if (ratio > 0.3) return { ok: false, reason: "logo 建议不超过码宽 30%" };
  if (ratio > 0.24 && ecc !== "H")
    return { ok: false, reason: "logo 超过 24% 时需 H 级纠错" };
  const count = qr.getModuleCount();
  const span = Math.ceil(count * ratio) + 1;
  const start = Math.floor((count - span) / 2);
  const end = start + span;
  // 三个定位图案（左上/右上/左下）7 模块保护带
  const finders = [
    [0, 0],
    [count - 7, 0],
    [0, count - 7],
  ];
  for (const [fx, fy] of finders) {
    const overlapX = start < fx + 8 && end > fx - 1;
    const overlapY = start < fy + 8 && end > fy - 1;
    if (overlapX && overlapY) return { ok: false, reason: "logo 与定位角重叠，请缩小或提高纠错" };
  }
  return { ok: true, reason: "", span, start };
}

export function qrSvg(qr, { fg = "#000000", bg = "#ffffff", size = 256, style = "square" } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(bg))
    throw new Error("颜色格式无效");
  const count = qr.getModuleCount(),
    dimension = count + 8;
  // square 保持单 path（体积最小、且为既有契约）；dot / rounded 使用对应图形元素
  if ((style || "square") === "square") {
    const paths = [];
    for (let row = 0; row < count; row++)
      for (let col = 0; col < count; col++)
        if (qr.isDark(row, col)) paths.push(`M${col + 4} ${row + 4}h1v1h-1z`);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(128, Math.min(2048, Number(size) || 256))}" height="${Math.max(128, Math.min(2048, Number(size) || 256))}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${bg}"/><path d="${paths.join("")}" fill="${fg}"/></svg>`;
  }
  const shapes = [];
  const r = dotRadius(style);
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.isDark(row, col)) shapes.push(moduleShape(style, col + 4, row + 4, r));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(128, Math.min(2048, Number(size) || 256))}" height="${Math.max(128, Math.min(2048, Number(size) || 256))}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${bg}"/><g fill="${fg}">${shapes.join("")}</g></svg>`;
}

export function decodedType(text) {
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return { label: "网页链接", url: url.href };
    } catch {
      /* Keep invalid URLs as plain text. */
    }
  }
  if (text.startsWith("WIFI:")) return { label: "Wi-Fi 配置" };
  if (/^BEGIN:VCARD/i.test(text)) return { label: "联系人" };
  if (/^mailto:/i.test(text)) return { label: "邮件" };
  if (/^smsto?:/i.test(text)) return { label: "短信" };
  return { label: "文本" };
}

export function commitHistory(history, entry, limit = 12) {
  return [
    { ...entry, at: Date.now() },
    ...history.filter((item) => item.text !== entry.text),
  ].slice(0, limit);
}
