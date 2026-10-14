// LCS 行级 diff + 行内字符细化 + unified diff 生成 + hex dump。可在 node 中直接自测。

/** 归一化行：忽略空白 / 忽略大小写 */
function normalizeLine(line, { ignoreWhitespace = false, ignoreCase = false } = {}) {
  let out = line;
  if (ignoreWhitespace) out = out.replace(/\s+/g, " ").trim();
  if (ignoreCase) out = out.toLowerCase();
  return out;
}

/**
 * 行级 LCS 对齐 → 变换脚本数组：
 * { type: 'same'|'del'|'add', aIndex?, bIndex? }
 */
export function diffLines(aText, bText, options = {}) {
  const a = String(aText ?? "").split("\n");
  const b = String(bText ?? "").split("\n");
  const an = a.map((l) => normalizeLine(l, options));
  const bn = b.map((l) => normalizeLine(l, options));
  const n = an.length,
    m = bn.length;
  // LCS 动态规划（上限保护：超长文本退化为按前缀对齐）
  const LIMIT = 4000;
  let script = [];
  if (n > LIMIT || m > LIMIT) {
    let i = 0;
    while (i < Math.min(n, m) && an[i] === bn[i]) i++;
    for (let k = i; k < n; k++) script.push({ type: "del", aIndex: k });
    for (let k = i; k < m; k++) script.push({ type: "add", bIndex: k });
    return script;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = an[i] === bn[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (an[i] === bn[j]) {
      script.push({ type: "same", aIndex: i, bIndex: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      script.push({ type: "del", aIndex: i });
      i++;
    } else {
      script.push({ type: "add", bIndex: j });
      j++;
    }
  }
  while (i < n) script.push({ type: "del", aIndex: i++ });
  while (j < m) script.push({ type: "add", bIndex: j++ });
  return script;
}

/** 相邻 del/add 配对成 hunk：{ type:'change', dels, adds }，供行内细化 */
export function pairHunks(script) {
  const hunks = [];
  let k = 0;
  while (k < script.length) {
    const op = script[k];
    if (op.type === "same") {
      hunks.push({ type: "same", line: op });
      k++;
      continue;
    }
    const dels = [],
      adds = [];
    while (k < script.length && script[k].type === "del") dels.push(script[k++]);
    while (k < script.length && script[k].type === "add") adds.push(script[k++]);
    if (dels.length && adds.length) hunks.push({ type: "change", dels, adds });
    else if (dels.length) hunks.push({ type: "del-only", dels });
    else hunks.push({ type: "add-only", adds });
  }
  return hunks;
}

/** 字符级 LCS，返回 [{ value, kind: 'same'|'ins'|'del' }] 段 */
export function diffChars(a, b) {
  if (a === b) return a ? [{ value: a, kind: "same" }] : [];
  const n = a.length,
    m = b.length;
  if (n * m > 4_000_000) return [{ value: a, kind: "del" }, { value: b, kind: "ins" }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const segments = [];
  const push = (kind, ch) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.value += ch;
    else segments.push({ value: ch, kind });
  };
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push("del", a[i++]);
    else push("ins", b[j++]);
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return segments;
}

export function countChanges(script) {
  let dels = 0,
    adds = 0;
  for (const op of script) {
    if (op.type === "del") dels++;
    else if (op.type === "add") adds++;
  }
  return { dels, adds };
}

/** 生成 unified diff 文本（不带时间戳，context 控制上下文行数） */
export function unifiedDiff(aText, bText, { from = "a", to = "b", context = 3, options = {} } = {}) {
  const script = diffLines(aText, bText, options);
  const { dels, adds } = countChanges(script);
  if (!dels && !adds) return "";
  const a = String(aText ?? "").split("\n");
  const b = String(bText ?? "").split("\n");
  const isChange = script.map((op) => op.type !== "same");
  // 标记 context 窗口内的行
  const inWindow = new Array(script.length).fill(false);
  script.forEach((_, idx) => {
    if (!isChange[idx]) return;
    for (let k = Math.max(0, idx - context); k <= Math.min(script.length - 1, idx + context); k++)
      inWindow[k] = true;
  });
  const lines = [`--- ${from}`, `+++ ${to}`];
  let idx = 0;
  while (idx < script.length) {
    if (!inWindow[idx]) {
      idx++;
      continue;
    }
    let end = idx;
    while (end + 1 < script.length && inWindow[end + 1]) end++;
    let aStart = -1,
      bStart = -1,
      aCount = 0,
      bCount = 0;
    const rows = [];
    for (let k = idx; k <= end; k++) {
      const op = script[k];
      if (op.type === "same") {
        rows.push(" " + (a[op.aIndex] ?? ""));
        aCount++;
        bCount++;
        if (aStart === -1) aStart = op.aIndex;
        if (bStart === -1) bStart = op.bIndex;
      } else if (op.type === "del") {
        rows.push("-" + (a[op.aIndex] ?? ""));
        aCount++;
        if (aStart === -1) aStart = op.aIndex;
      } else {
        rows.push("+" + (b[op.bIndex] ?? ""));
        bCount++;
        if (bStart === -1) bStart = op.bIndex;
      }
    }
    if (aStart === -1) aStart = aCount ? a.length : 0;
    if (bStart === -1) bStart = bCount ? b.length : 0;
    lines.push(`@@ -${aStart + 1},${aCount} +${bStart + 1},${bCount} @@`, ...rows);
    idx = end + 1;
  }
  return lines.join("\n");
}

/** hex dump：每行 offset 8 字节十六进制 + 可打印预览 */
export function hexDump(text, bytesPerLine = 16) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  const out = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerLine) {
    const chunk = bytes.slice(offset, offset + bytesPerLine);
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const printable = [...chunk]
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·"))
      .join("");
    out.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(bytesPerLine * 3 - 1)}  |${printable}|`);
  }
  return out.join("\n");
}
