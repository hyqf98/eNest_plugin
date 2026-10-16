// 纯逻辑：样例匹配、具名分组展开、替换串解析与逐段 diff。可在 node 中直接自测。
export const FLAG_DEFS = [
  { key: "g", label: "全局", detail: "找出全部匹配，而非第一处后停止" },
  { key: "i", label: "忽略大小写", detail: "abc 同时命中 ABC" },
  { key: "m", label: "多行模式", detail: "^ $ 分别匹配每一行的首尾" },
  { key: "s", label: "点号通配", detail: "点号 . 额外匹配换行符" },
  { key: "u", label: "Unicode", detail: "按码位解析，\\p{…} 属性转义可用" },
  { key: "y", label: "粘性匹配", detail: "只从 lastIndex 处开始匹配" },
];

/** 匹配上限，防止灾难性回溯拖垮 UI */
export const MATCH_LIMIT = 500;

export function compilePattern(source, flags) {
  if (!source) return null;
  return new RegExp(source, flags);
}

/** 返回全部匹配（含分组视图）；上限防止灾难性回溯拖垮 UI */
export function collectMatches(regexp, text, limit = 500) {
  if (!regexp || !text) return [];
  const matches = [];
  if (regexp.global || regexp.sticky) {
    let guard = 0;
    while (matches.length < limit) {
      const m = regexp.exec(text);
      if (!m) break;
      matches.push(view(m));
      if (m[0] === "") regexp.lastIndex++;
      if (++guard > limit * 4) break;
    }
    regexp.lastIndex = 0;
  } else {
    const m = regexp.exec(text);
    if (m) matches.push(view(m));
  }
  return matches;
}

function view(m) {
  return {
    index: m.index,
    text: m[0],
    end: m.index + m[0].length,
    line: lineOfIndex(m.input, m.index),
    groups: m.slice(1).map((value, i) => ({ ref: i + 1, value })),
    named: namedGroups(m),
  };
}

/** 1 起始的行号，用于「第 N 行」定位展示 */
export function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function namedGroups(m) {
  const names = m.groups ? Object.keys(m.groups) : [];
  const out = {};
  for (const name of names) out[name] = m.groups[name];
  return out;
}

/** 具名分组树：每个匹配一行 $1..$n（优先具名） */
export function groupRows(match) {
  if (!match) return [];
  const names = Object.keys(match.named || {});
  const rows = [];
  if (names.length) {
    for (const name of names) rows.push({ ref: "$<" + name + ">", value: match.named[name] });
  }
  match.groups.forEach((g) => rows.push({ ref: "$" + g.ref, value: g.value }));
  return rows;
}

/** 解析替换串：$1、$<name>、$$、$&、$`、$' 字面化规则足够日常使用 */
export function parseReplacement(input) {
  const parts = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "$") {
      parts.push({ type: "text", value: ch });
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next === "$") {
      parts.push({ type: "text", value: "$" });
      i += 2;
    } else if (next === "<") {
      const end = input.indexOf(">", i + 2);
      if (end === -1) {
        parts.push({ type: "text", value: input.slice(i) });
        break;
      }
      parts.push({ type: "named", value: input.slice(i + 2, end) });
      i = end + 1;
    } else if (next && /\d/.test(next)) {
      let j = i + 1;
      while (j < input.length && /\d/.test(input[j])) j++;
      parts.push({ type: "group", value: Number(input.slice(i + 1, j)) });
      i = j;
    } else if (next === "&" || next === "`" || next === "'") {
      parts.push({ type: "special", value: next });
      i += 2;
    } else {
      parts.push({ type: "text", value: "$" });
      i++;
    }
  }
  return parts;
}

/** 用解析结果渲染单个匹配的替换文本 */
export function applyReplacement(parts, match, source) {
  let out = "";
  for (const part of parts) {
    if (part.type === "text") out += part.value;
    else if (part.type === "group") {
      const g = match.groups[part.value - 1];
      out += g && g.value != null ? g.value : "";
    } else if (part.type === "named") {
      const v = match.named[part.value];
      out += v != null ? v : "";
    } else if (part.type === "special") {
      if (part.value === "&") out += match.text;
      else if (part.value === "`") out += source.slice(0, match.index);
      else if (part.value === "'") out += source.slice(match.end);
    }
  }
  return out;
}

export function replaceAll(matches, parts, source) {
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += source.slice(cursor, m.index);
    out += applyReplacement(parts, m, source);
    cursor = m.end;
  }
  out += source.slice(cursor);
  return out;
}

/** 旧文本 → 新文本 的逐段差异（行数组），供 diff 高亮 */
export function diffSegments(before, after) {
  if (before === after) return [{ type: "same", value: before }].filter((s) => s.value);
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let endB = before.length,
    endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const segments = [];
  if (start) segments.push({ type: "same", value: before.slice(0, start) });
  if (endB > start) segments.push({ type: "del", value: before.slice(start, endB) });
  if (endA > start) segments.push({ type: "ins", value: after.slice(start, endA) });
  if (endB < before.length) segments.push({ type: "same", value: before.slice(endB) });
  return segments;
}

export const DEFAULT_SNIPPETS = [
  { name: "手机号", body: "1[3-9]\\d{9}" },
  { name: "邮箱", body: "[\\w.+-]+@[\\w-]+\\.[\\w.]+" },
  { name: "URL", body: "https?://[^\\s]+" },
  { name: "IPv4", body: "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}" },
  { name: "身份证", body: "[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\\d|3[01])\\d{3}[\\dXx]" },
  { name: "日期", body: "(\\d{4})-(\\d{1,2})-(\\d{1,2})" },
  { name: "时间", body: "([01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?" },
  { name: "整数", body: "-?\\d+" },
  { name: "浮点数", body: "-?\\d+(?:\\.\\d+)?" },
  { name: "十六进制色", body: "#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b" },
  { name: "中文", body: "[\\u4e00-\\u9fa5]+" },
  { name: "空白行", body: "^\\s*$" },
  { name: "HTML 标签", body: "<([a-z][a-z0-9]*)\\b[^>]*>" },
  { name: "QQ 号", body: "[1-9]\\d{4,10}" },
];

/**
 * 模板库：分类 + 表达式 + 示例文本，一键填入后立即可见匹配效果。
 * category 取「常用 / 网络 / 数字 / 文本」四类，避免长列表无结构。
 */
export const TEMPLATE_LIBRARY = [
  { category: "常用", name: "邮箱地址", body: "[\\w.+-]+@[\\w-]+\\.[\\w.]+", sample: "联系 alice@example.com 或 bob.smith@mail.co.uk" },
  { category: "常用", name: "手机号", body: "1[3-9]\\d{9}", sample: "电话 13812345678，备用 15987654321。" },
  { category: "常用", name: "身份证号", body: "[1-9]\\d{5}(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\\d|3[01])\\d{3}[\\dXx]", sample: "身份证：110101199003077670" },
  { category: "常用", name: "日期（年-月-日）", body: "(?<y>\\d{4})-(?<m>\\d{1,2})-(?<d>\\d{1,2})", sample: "下单 2026-09-15，交付 2026-10-01" },
  { category: "常用", name: "时间（时:分:秒）", body: "(?<h>(?:[01]\\d|2[0-3])):(?<min>[0-5]\\d)(?::(?<s>[0-5]\\d))?", sample: "会议 08:30 开始，14:05:30 结束" },
  { category: "网络", name: "URL", body: "https?://[^\\s>\"']+", sample: "见 https://example.com/docs?a=1 与 http://api.test.cn/v2" },
  { category: "网络", name: "IPv4", body: "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)){3}", sample: "主机 192.168.1.23，网关 10.0.0.1" },
  { category: "网络", name: "域名", body: "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}", sample: "访问 static.example-cdn.cn:8443" },
  { category: "网络", name: "十六进制色", body: "#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\\b", sample: "主题色 #3579dd，浅色 #eee" },
  { category: "数字", name: "整数", body: "-?\\d+", sample: "数量 -3，单价 1299" },
  { category: "数字", name: "浮点数", body: "-?\\d+(?:\\.\\d+)?", sample: "重量 47.2kg，误差 -0.5" },
  { category: "数字", name: "千分位金额", body: "\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?", sample: "合计 1,299,000.00 元" },
  { category: "文本", name: "中文字符", body: "[\\u4e00-\\u9fa5]+", sample: "eNest 是一款桌面插件壳子" },
  { category: "文本", name: "空白行", body: "^\\s*$", sample: "第一行\n\n\n第二行" },
  { category: "文本", name: "HTML 标签", body: "<([a-z][a-z0-9]*)\\b[^>]*>", sample: "<div class=\"box\"><p>文本</p></div>" },
  { category: "文本", name: "重复单词", body: "\\b(\\w+)\\s+\\1\\b", sample: "this this is a a demo" },
];

/** 按类别归组模板，供侧栏树渲染；保持类别顺序稳定 */
export function templateGroups(library = TEMPLATE_LIBRARY) {
  const groups = new Map();
  for (const tpl of library) {
    if (!groups.has(tpl.category)) groups.set(tpl.category, []);
    groups.get(tpl.category).push(tpl);
  }
  return [...groups.entries()].map(([name, items]) => ({ name, items }));
}

export const CHEATSHEET = [
  {
    title: "元字符",
    rows: [
      [".", "任意字符（除换行，s 标志含换行）"],
      ["\\d \\D", "数字 / 非数字"],
      ["\\w \\W", "单词字符 [A-Za-z0-9_] / 非单词字符"],
      ["\\s \\S", "空白 / 非空白"],
      ["\\b \\B", "单词边界 / 非边界"],
      ["[abc] [^abc]", "字符集合 / 排除型集合"],
      ["[a-z]", "范围"],
    ],
  },
  {
    title: "量词",
    rows: [
      ["* + ?", "0+ / 1+ / 0 或 1 次"],
      ["{n} {n,} {n,m}", "恰好 n / 至少 n / n 到 m 次"],
      ["*? +? ??", "懒惰（最少匹配）"],
    ],
  },
  {
    title: "分组与引用",
    rows: [
      ["(exp)", "捕获分组 $1..$n"],
      ["(?:exp)", "非捕获分组"],
      ["(?<name>exp)", "具名分组 $<name>"],
      ["\\1", "反向引用第 1 组"],
      ["a|b", "或"],
    ],
  },
  {
    title: "断言",
    rows: [
      ["^ $", "行首 / 行尾（m 标志多行）"],
      ["(?=exp)", "正向先行"],
      ["(?!exp)", "负向先行"],
      ["(?<=exp)", "正向后行"],
      ["(?<!exp)", "负向后行"],
    ],
  },
];
