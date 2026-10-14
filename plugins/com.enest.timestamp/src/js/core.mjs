export function zoneParts(ms, zone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}
export function formatZoned(
  ms,
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) {
  const p = zoneParts(ms, zone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
export function zonedToMs(text, zone) {
  const m = text.match(
    /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,3}))?)?$/,
  );
  if (!m) throw new Error("使用 YYYY-MM-DD HH:mm:ss，或带时区的 ISO 时间");
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map((v) => Number(v || 0));
  const milli = Number((m[7] || "").padEnd(3, "0"));
  const target = Date.UTC(y, mo - 1, d, h, mi, s, milli);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = zoneParts(guess, zone);
    const shown = Date.UTC(
      +p.year,
      +p.month - 1,
      +p.day,
      +p.hour,
      +p.minute,
      +p.second,
      milli,
    );
    const delta = target - shown;
    guess += delta;
    if (!delta) break;
  }
  const expected = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || "00"}`;
  if (formatZoned(guess, zone) !== expected)
    throw new Error("日期不存在，或落在夏令时跳过的时间段");
  return guess;
}
export function parseTime(
  value,
  unit = "auto",
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = Date.now(),
) {
  const text = String(value).trim();
  if (!text || /^(now|现在)$/i.test(text)) return now;
  const relative = /^([+-]?\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(text);
  let ms;
  if (relative)
    ms =
      now +
      Number(relative[1]) *
        { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[
          relative[2].toLowerCase()
        ];
  else if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    ms =
      n * (unit === "s" || (unit === "auto" && Math.abs(n) < 1e11) ? 1000 : 1);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(text))
    ms = zonedToMs(text + " 00:00:00", zone);
  else if (
    /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)
  )
    ms = zonedToMs(text, zone);
  else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text))
    ms = Date.parse(text);
  else throw new Error("无法识别：支持时间戳、ISO 日期、±30m / ±2d");
  if (!Number.isFinite(ms) || Math.abs(ms) > 8640000000000000)
    throw new Error("超出日期范围");
  return Math.trunc(ms);
}
export function timeRows(ms, zone) {
  const local = formatZoned(ms, zone);
  return [
    { label: zone, value: local },
    { label: "Unix 秒", value: String(Math.floor(ms / 1000)) },
    { label: "Unix 毫秒", value: String(ms) },
    { label: "ISO 8601 · UTC", value: new Date(ms).toISOString() },
    { label: "UTC", value: formatZoned(ms, "UTC") },
    { label: "日期", value: local.slice(0, 10).replaceAll("-", "/") },
    { label: "时间", value: local.slice(11) },
  ];
}
export function durationText(ms) {
  const sign = ms < 0 ? "−" : "";
  let s = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86400);
  s %= 86400;
  const hours = Math.floor(s / 3600);
  s %= 3600;
  return `${sign}${days} 天 ${hours} 小时 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
