// Cron 五/六域解析、下次执行计算、自然语言描述与 crontab 宏。可在 node 中直接自测。

export const DOMAINS = [
  { key: "second", label: "秒", index: 0, min: 0, max: 59, names: null },
  { key: "minute", label: "分", index: 1, min: 0, max: 59, names: null },
  { key: "hour", label: "时", index: 2, min: 0, max: 23, names: null },
  { key: "day", label: "日", index: 3, min: 1, max: 31, names: null },
  { key: "month", label: "月", index: 4, min: 1, max: 12, names: null },
  { key: "week", label: "周", index: 5, min: 0, max: 6, names: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } },
];

export const WEEK_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/**
 * 解析单域表达式为命中的数值集合：星号、步进（星号/步长）、区间、区间步进、列表与英文名。
 * week 域支持 7=0 折叠与英文缩写（mon/tue…）。
 */
export function parseField(source, domain) {
  const text = String(source ?? "").trim();
  if (!text) throw new Error(`${domain.label}域为空`);
  const values = new Set();
  for (const part of text.split(",")) {
    const chunk = part.trim().toLowerCase();
    if (!chunk) throw new Error(`${domain.label}域存在空列表项`);
    let body = chunk,
      step = 1;
    const slash = chunk.indexOf("/");
    if (slash !== -1) {
      body = chunk.slice(0, slash);
      step = Number(chunk.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) throw new Error(`${domain.label}域步进非法：${chunk}`);
    }
    const range = parseRange(body, domain);
    if (slash === -1 && range.length === 2 && range[0] <= range[1]) {
      // 单值（无步进无范围）
      if (body !== "*" && !body.includes("-")) {
        values.add(range[0]);
        continue;
      }
    }
    if (body === "*" && slash === -1) {
      for (let v = domain.min; v <= domain.max; v++) values.add(v);
      continue;
    }
    const [from, to] = range;
    const upper = body === "*" ? domain.max : to;
    for (let v = from; v <= upper; v += step) values.add(normalizeWeek(v, domain));
    if (body !== "*") {
      // 修正区间端点含 7（周日）折叠
      if (domain.key === "week" && to === 7 && from <= 7) values.add(0);
    }
  }
  if (!values.size) throw new Error(`${domain.label}域没有可用值：${text}`);
  for (const v of values)
    if (v < domain.min || v > domain.max) throw new Error(`${domain.label}域超出范围：${v}`);
  return values;
}

function parseRange(body, domain) {
  const resolveToken = (token) => {
    if (token === "*" || token === "") return null;
    if (/^\d+$/.test(token)) return Number(token);
    if (domain.names) {
      const named = domain.names[token];
      if (named !== undefined) return named;
    }
    throw new Error(`${domain.label}域无法识别：${token}`);
  };
  if (body === "*") return [domain.min, domain.max];
  const dash = body.indexOf("-");
  if (dash === -1) {
    const v = resolveToken(body);
    return [v, v];
  }
  const from = resolveToken(body.slice(0, dash));
  const to = resolveToken(body.slice(dash + 1));
  if (from == null || to == null) throw new Error(`${domain.label}域范围不完整：${body}`);
  if (domain.key !== "week" && from > to) throw new Error(`${domain.label}域范围倒置：${body}`);
  return [from, to];
}

function normalizeWeek(v, domain) {
  if (domain.key === "week" && v === 7) return 0;
  return v;
}

/** 解析完整表达式；withSeconds 时第一域为秒 */
export function parseExpression(source, { withSeconds = false } = {}) {
  const text = String(source ?? "").trim();
  if (!text) throw new Error("表达式为空");
  if (MACROS[text.toLowerCase()]) return parseExpression(MACROS[text.toLowerCase()], { withSeconds });
  const parts = text.split(/\s+/);
  const expected = withSeconds ? 6 : 5;
  if (parts.length !== expected)
    throw new Error(`期望 ${expected} 个域（${withSeconds ? "秒 分 时 日 月 周" : "分 时 日 月 周"}），实际 ${parts.length} 个`);
  const domains = withSeconds ? DOMAINS : DOMAINS.slice(1);
  const sets = [];
  for (const domain of domains) sets[domain.index] = parseField(parts[withSeconds ? domain.index : domain.index - 1], domain);
  return { raw: text, withSeconds, sets };
}

/** 从基准时间向后扫描下一次命中（逐分钟，秒级逐秒）。上限 366 天。 */
export function nextFire(schedule, from = new Date(), limit = 5) {
  const results = [];
  const cursor = new Date(from.getTime());
  cursor.setMilliseconds(0);
  const stepMs = schedule.withSeconds ? 1000 : 60000;
  const maxSteps = 366 * 24 * 60 * (schedule.withSeconds ? 60 : 1);
  let steps = 0;
  while (results.length < limit && steps < maxSteps) {
    cursor.setTime(cursor.getTime() + stepMs);
    if (schedule.withSeconds ? matchesSecond(schedule, cursor) : matchesMinute(schedule, cursor))
      results.push(new Date(cursor.getTime()));
    steps++;
  }
  if (results.length < limit)
    throw new Error("一年内没有找到匹配的执行时间，请检查日/月/周组合");
  return results;
}

/* 分钟粒度命中：秒固定为 0 */
function matchesMinute(schedule, date) {
  return matchesCore(schedule, date, 0);
}
function matchesSecond(schedule, date) {
  return matchesCore(schedule, date, date.getSeconds());
}

function isWildcard(set, min, max) {
  if (set.size !== max - min + 1) return false;
  for (let v = min; v <= max; v++) if (!set.has(v)) return false;
  return true;
}

function matchesCore(schedule, date, second) {
  const s = schedule.withSeconds;
  const minute = schedule.sets[1],
    hour = schedule.sets[2],
    day = schedule.sets[3],
    month = schedule.sets[4],
    week = schedule.sets[5];
  if (!month.has(date.getMonth() + 1)) return false;
  if (!hour.has(date.getHours())) return false;
  if (!minute.has(date.getMinutes())) return false;
  if (s && !schedule.sets[0].has(second)) return false;
  const dayAny = isWildcard(day, 1, 31);
  const weekAny = isWildcard(week, 0, 6);
  if (dayAny && weekAny) return true;
  if (dayAny) return week.has(date.getDay());
  if (weekAny) return day.has(date.getDate());
  // 两者都受限：标准 cron 取或
  return day.has(date.getDate()) || week.has(date.getDay());
}

/** 自然语言描述（中文） */
export function describe(schedule) {
  const s = schedule.withSeconds;
  const second = schedule.sets[0],
    minute = schedule.sets[1],
    hour = schedule.sets[2],
    day = schedule.sets[3],
    month = schedule.sets[4],
    week = schedule.sets[5];
  const list = (set) => [...set].sort((a, b) => a - b);
  const segs = [];
  const weekText = isWildcard(week, 0, 6) ? "" : "每" + list(week).map((w) => WEEK_LABELS[w]).join("、");
  const dayText = isWildcard(day, 1, 31) ? "" : `每月 ${list(day).join("、")} 日`;
  const monthSeg = isWildcard(month, 1, 12) ? "" : `${list(month).join("、")} 月`;
  if (monthSeg) segs.push(monthSeg);
  if (weekText && dayText) segs.push(`${dayText}（${weekText.replace(/^每/, "")}）`);
  else if (dayText) segs.push(dayText);
  else if (weekText) segs.push(weekText);

  const hourArr = list(hour);
  const minuteArr = list(minute);
  let timeText;
  const hourStep = stepSpan(hour, 0, 23);
  const minuteStep = stepSpan(minute, 0, 59);
  if (hourStep && minuteArr.length === 60) timeText = hourStep === "每小时" ? "每小时" : `每 ${hourStep} 小时`;
  else if (minuteStep && hourArr.length === 24) timeText = minuteStep === "每分钟" ? "每分钟" : `每 ${minuteStep} 分钟`;
  else if (hourArr.length === 24) timeText = "每小时";
  else {
    const hh = (h) => String(h).padStart(2, "0");
    const mm = (m) => String(m).padStart(2, "0");
    const times = hourArr.slice(0, 6).flatMap((h) =>
      minuteArr.length > 4 ? [`${hh(h)}:${mm(minuteArr[0])}`, "…"] : minuteArr.map((m) => `${hh(h)}:${mm(m)}`),
    );
    timeText = times.slice(0, 8).join(" ");
    if (times.length > 8) timeText += " …";
  }
  if (s && !isWildcard(second, 0, 59)) timeText += ` 第 ${list(second).slice(0, 4).join("、")} 秒`;
  segs.push(timeText);
  return segs.join(" · ") || schedule.raw;
}

/** 等差满跨度序列返回步长文案，否则 null */
function stepSpan(set, min, max) {
  const arr = [...set].sort((a, b) => a - b);
  if (arr.length < 2) return null;
  const diff = arr[1] - arr[0];
  if (diff <= 1) return null;
  for (let k = 2; k < arr.length; k++) if (arr[k] - arr[k - 1] !== diff) return null;
  if (arr[0] !== min || arr[arr.length - 1] > max) return null;
  return String(diff);
}

export const PRESETS = [
  { name: "每天凌晨 3 点", expr: "0 3 * * *" },
  { name: "工作日早上 9 点", expr: "0 9 * * 1-5" },
  { name: "每小时整点", expr: "0 * * * *" },
  { name: "每 5 分钟", expr: "*/5 * * * *" },
  { name: "每 15 分钟", expr: "*/15 * * * *" },
  { name: "每月 1 号零点", expr: "0 0 1 * *" },
  { name: "每周一 08:30", expr: "30 8 * * 1" },
  { name: "每周日凌晨 2 点", expr: "0 2 * * 0" },
  { name: "每季度首月 1 号", expr: "0 0 1 1,4,7,10 *" },
  { name: "每天 12 点与 18 点", expr: "0 12,18 * * *" },
  { name: "工作日每小时第 30 分", expr: "30 * * * 1-5" },
  { name: "每月 15 号晚上 22 点", expr: "0 22 15 * *" },
];

export const FIELD_CHIPS = {
  minute: [
    { label: "*", value: "*", title: "每分钟" },
    { label: "*/5", value: "*/5" },
    { label: "*/10", value: "*/10" },
    { label: "*/15", value: "*/15" },
    { label: "*/30", value: "*/30" },
  ],
  hour: [
    { label: "*", value: "*" },
    { label: "*/2", value: "*/2" },
    { label: "*/6", value: "*/6" },
    { label: "9-18", value: "9-18" },
  ],
  day: [
    { label: "*", value: "*" },
    { label: "1", value: "1" },
    { label: "1,15", value: "1,15" },
    { label: "*/2", value: "*/2" },
  ],
  month: [
    { label: "*", value: "*" },
    { label: "*/3", value: "*/3" },
    { label: "1-6", value: "1-6" },
    { label: "1,4,7,10", value: "1,4,7,10" },
  ],
  week: [
    { label: "*", value: "*" },
    { label: "1-5", value: "1-5", title: "周一到周五" },
    { label: "0,6", value: "0,6", title: "周末" },
    { label: "1", value: "1", title: "周一" },
  ],
  second: [
    { label: "*", value: "*" },
    { label: "*/10", value: "*/10" },
    { label: "*/30", value: "*/30" },
    { label: "0", value: "0" },
  ],
};

/** crontab 行解析：支持宏与注释、环境行 */
export function parseCrontabLine(line) {
  const text = line.trim();
  if (!text || text.startsWith("#")) return null;
  if (text.startsWith("@")) {
    const macro = MACROS[text.toLowerCase()];
    if (!macro) throw new Error(`未知宏：${text}`);
    return macro;
  }
  return text;
}

/** 把解析出的调度格式化回标准 5/6 域表达式 */
export function formatSchedule(schedule) {
  const domains = schedule.withSeconds ? DOMAINS : DOMAINS.slice(1);
  return domains
    .map((domain) => {
      const set = schedule.sets[domain.index];
      const arr = [...set].sort((a, b) => a - b);
      if (isWildcard(set, domain.min, domain.max)) return "*";
      // 连续等差序列压缩为 a-b/n 或 */n
      if (arr.length > 2) {
        const diff = arr[1] - arr[0];
        let steady = diff > 0;
        for (let k = 2; k < arr.length; k++) if (arr[k] - arr[k - 1] !== diff) steady = false;
        if (steady && arr[0] === domain.min && arr[arr.length - 1] + diff > domain.max)
          return diff === 1 ? "*" : `*/${diff}`;
        if (steady) return diff === 1 ? `${arr[0]}-${arr[arr.length - 1]}` : `${arr[0]}-${arr[arr.length - 1]}/${diff}`;
      }
      if (arr.length === 1) return String(arr[0]);
      if (arr.length === 2 && arr[1] - arr[0] === 1) return `${arr[0]}-${arr[1]}`;
      return arr.join(",");
    })
    .join(" ");
}
