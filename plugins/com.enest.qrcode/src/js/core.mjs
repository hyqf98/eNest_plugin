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
export function qrSvg(qr, { fg = "#000000", bg = "#ffffff", size = 256 } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(fg) || !/^#[0-9a-f]{6}$/i.test(bg))
    throw new Error("颜色格式无效");
  const count = qr.getModuleCount(),
    dimension = count + 8,
    paths = [];
  for (let r = 0; r < count; r++)
    for (let c = 0; c < count; c++)
      if (qr.isDark(r, c)) paths.push(`M${c + 4} ${r + 4}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(128, Math.min(2048, Number(size) || 256))}" height="${Math.max(128, Math.min(2048, Number(size) || 256))}" viewBox="0 0 ${dimension} ${dimension}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${bg}"/><path d="${paths.join("")}" fill="${fg}"/></svg>`;
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
  return { label: "文本" };
}
export function commitHistory(history, entry, limit = 12) {
  return [
    { ...entry, at: Date.now() },
    ...history.filter((item) => item.text !== entry.text),
  ].slice(0, limit);
}
