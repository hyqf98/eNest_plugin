export function parseJson(source) {
  if (new TextEncoder().encode(source).length > 8 * 1024 * 1024)
    throw new Error("输入超过 8 MB");
  let i = 0,
    nodes = 0,
    maxDepth = 0,
    keys = 0;
  const fail = (message, at = i) => {
    const before = source.slice(0, at);
    const line = before.split("\n").length;
    const column = at - before.lastIndexOf("\n");
    const error = new Error(`第 ${line} 行第 ${column} 列：${message}`);
    error.position = at;
    throw error;
  };
  const ws = () => {
    while (/[\x20\t\r\n]/.test(source[i] || "\0")) i++;
  };
  function string() {
    const start = i++;
    while (i < source.length) {
      if (source[i] === '"') {
        i++;
        try {
          return JSON.parse(source.slice(start, i));
        } catch {
          fail("字符串或转义无效", start);
        }
      }
      if (source.charCodeAt(i) < 32) fail("字符串内不能含未转义控制字符");
      if (source[i] === "\\") i++;
      i++;
    }
    fail("字符串未闭合", start);
  }
  function value(depth) {
    ws();
    if (++nodes > 250000) fail("节点超过 250000，分批处理");
    if (depth > 256) fail("嵌套超过 256 层");
    maxDepth = Math.max(maxDepth, depth);
    const start = i,
      c = source[i];
    if (c === '"') return { kind: "string", value: string(), start };
    if (c === "{") {
      i++;
      ws();
      const entries = [];
      if (source[i] === "}") {
        i++;
        return { kind: "object", entries, start };
      }
      while (true) {
        ws();
        if (source[i] !== '"') fail("对象键必须是双引号字符串");
        const key = string();
        keys++;
        ws();
        if (source[i++] !== ":") fail("对象键后缺少冒号", i - 1);
        entries.push({ key, value: value(depth + 1) });
        ws();
        const next = source[i++];
        if (next === "}") break;
        if (next !== ",") fail("对象成员后需要逗号或 }", i - 1);
      }
      return { kind: "object", entries, start };
    }
    if (c === "[") {
      i++;
      ws();
      const items = [];
      if (source[i] === "]") {
        i++;
        return { kind: "array", items, start };
      }
      while (true) {
        items.push(value(depth + 1));
        ws();
        const next = source[i++];
        if (next === "]") break;
        if (next !== ",") fail("数组元素后需要逗号或 ]", i - 1);
      }
      return { kind: "array", items, start };
    }
    for (const literal of ["true", "false", "null"])
      if (source.startsWith(literal, i)) {
        i += literal.length;
        return {
          kind: literal === "null" ? "null" : "boolean",
          raw: literal,
          start,
        };
      }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(i),
    );
    if (number) {
      i += number[0].length;
      return { kind: "number", raw: number[0], start };
    }
    fail(i === source.length ? "输入不完整" : "无效值");
  }
  const root = value(1);
  ws();
  if (i !== source.length) fail("值后存在多余内容");
  return { root, stats: { nodes, maxDepth, keys } };
}
export function stringifyJson(node, indent = 2, sort = false) {
  const unit = " ".repeat(Math.max(0, Math.min(8, indent)));
  function write(n, depth) {
    if (n.kind === "string") return JSON.stringify(n.value);
    if (n.kind !== "array" && n.kind !== "object") return n.raw;
    const object = n.kind === "object";
    const members = object
      ? sort
        ? [...n.entries].sort((a, b) =>
            a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
          )
        : n.entries
      : n.items;
    const values = members.map((v) =>
      object
        ? JSON.stringify(v.key) +
          (unit ? ": " : ":") +
          write(v.value, depth + 1)
        : write(v, depth + 1),
    );
    const open = object ? "{" : "[",
      close = object ? "}" : "]";
    if (!values.length) return open + close;
    return unit
      ? open +
          "\n" +
          unit.repeat(depth + 1) +
          values.join(",\n" + unit.repeat(depth + 1)) +
          "\n" +
          unit.repeat(depth) +
          close
      : open + values.join(",") + close;
  }
  return write(node, 0);
}
export const pointerPart = (key) =>
  String(key).replaceAll("~", "~0").replaceAll("/", "~1");
export function childNodes(node, path = "") {
  if (node.kind === "object")
    return node.entries.map((e) => ({
      label: e.key,
      path: path + "/" + pointerPart(e.key),
      node: e.value,
    }));
  if (node.kind === "array")
    return node.items.map((n, i) => ({
      label: String(i),
      path: path + "/" + i,
      node: n,
    }));
  return [];
}
export function searchJson(root, query) {
  const q = query.toLowerCase(),
    matches = [];
  if (!q) return matches;
  const stack = [{ label: "$", path: "", node: root }];
  while (stack.length) {
    const item = stack.pop();
    const text =
      item.node.kind === "string" ? item.node.value : item.node.raw || "";
    if ((item.label + " " + text + " " + item.path).toLowerCase().includes(q))
      matches.push(item);
    for (const child of childNodes(item.node, item.path).reverse())
      stack.push(child);
  }
  return matches;
}
export function diffJson(left, right) {
  const diffs = [];
  function walk(a, b, path) {
    if (!a || !b) {
      diffs.push({
        path: path || "/",
        type: a ? "删除" : "新增",
        before: a ? stringifyJson(a, 0) : "",
        after: b ? stringifyJson(b, 0) : "",
      });
      return;
    }
    if (a.kind !== b.kind) {
      diffs.push({
        path: path || "/",
        type: "类型变化",
        before: stringifyJson(a, 0),
        after: stringifyJson(b, 0),
      });
      return;
    }
    if (a.kind === "array") {
      for (let i = 0; i < Math.max(a.items.length, b.items.length); i++)
        walk(a.items[i], b.items[i], path + "/" + i);
    } else if (a.kind === "object") {
      const aKeys = a.entries.map((e) => e.key),
        bKeys = b.entries.map((e) => e.key);
      if (
        new Set(aKeys).size !== aKeys.length ||
        new Set(bKeys).size !== bKeys.length
      ) {
        if (stringifyJson(a, 0) !== stringifyJson(b, 0))
          diffs.push({
            path: path || "/",
            type: "含重复键的对象变化",
            before: stringifyJson(a, 0),
            after: stringifyJson(b, 0),
          });
        return;
      }
      const am = new Map(a.entries.map((e) => [e.key, e.value])),
        bm = new Map(b.entries.map((e) => [e.key, e.value]));
      for (const key of new Set([...am.keys(), ...bm.keys()]))
        walk(am.get(key), bm.get(key), path + "/" + pointerPart(key));
    } else if (stringifyJson(a, 0) !== stringifyJson(b, 0))
      diffs.push({
        path: path || "/",
        type: "修改",
        before: stringifyJson(a, 0),
        after: stringifyJson(b, 0),
      });
  }
  walk(left, right, "");
  return diffs;
}
export function unescapeText(text) {
  const source = text.trim();
  const value = source.startsWith('"')
    ? JSON.parse(source)
    : JSON.parse('"' + source + '"');
  if (typeof value !== "string")
    throw new Error("请输入转义文本或 JSON 字符串");
  return value;
}

/* ── 文本视图：语法高亮与结构折叠 ── */
const HTML_ESCAPE = (value) =>
  value.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch],
  );
const JSON_STRING_RE = /"(?:\\.|[^"\\])*"/y;
const JSON_NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_WORD_RE = /[A-Za-z]+/y;
/** 高亮与折叠的降级阈值：超过即回退纯文本 textarea，避免大文档卡顿 */
export const HIGHLIGHT_CHAR_LIMIT = 400000;
export const HIGHLIGHT_LINE_LIMIT = 3000;

/** JSON 文本 → 着色 HTML（tk-key/tk-str/tk-num/tk-lit/tk-punct）；超限返回 null 由调用方降级 */
export function highlightJsonHtml(text) {
  const s = String(text ?? "");
  if (s.length > HIGHLIGHT_CHAR_LIMIT) return null;
  const out = [];
  let plainStart = 0;
  const flush = (end) => {
    if (end > plainStart) out.push(HTML_ESCAPE(s.slice(plainStart, end)));
    plainStart = end;
  };
  const emit = (cls, token) => {
    out.push(
      cls
        ? `<span class="tk-${cls}">${HTML_ESCAPE(token)}</span>`
        : HTML_ESCAPE(token),
    );
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      JSON_STRING_RE.lastIndex = i;
      const m = JSON_STRING_RE.exec(s);
      const token = m ? m[0] : s.slice(i); // 未闭合字符串兜底（有效 JSON 不会出现）
      let j = i + token.length;
      while (j < s.length && (s[j] === " " || s[j] === "\t" || s[j] === "\n" || s[j] === "\r")) j++;
      flush(i);
      emit(s[j] === ":" ? "key" : "str", token);
      i += token.length;
      plainStart = i;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      JSON_NUMBER_RE.lastIndex = i;
      const m = JSON_NUMBER_RE.exec(s);
      const token = m ? m[0] : ch;
      flush(i);
      emit("num", token);
      i += token.length;
      plainStart = i;
    } else if (ch >= "a" && ch <= "z") {
      JSON_WORD_RE.lastIndex = i;
      const m = JSON_WORD_RE.exec(s);
      const token = m ? m[0] : ch;
      flush(i);
      emit(token === "true" || token === "false" || token === "null" ? "lit" : null, token);
      i += token.length;
      plainStart = i;
    } else if ("{}[]:,".includes(ch)) {
      flush(i);
      emit("punct", ch);
      i++;
      plainStart = i;
    } else i++;
  }
  flush(s.length);
  return out.join("");
}

/** 跳过字符串内容后按括号配对扫描 → 折叠区间 [{start,end,depth}]（0 起行号、含首尾）；超限返回 null */
export function computeJsonFolds(text) {
  const s = String(text ?? "");
  if (s.length > HIGHLIGHT_CHAR_LIMIT) return null;
  const folds = [];
  const stack = [];
  let line = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\n") line++;
    else if (ch === '"') {
      JSON_STRING_RE.lastIndex = i;
      const m = JSON_STRING_RE.exec(s);
      i += m ? m[0].length : 1;
      continue;
    } else if (ch === "{" || ch === "[") stack.push({ line, depth: stack.length });
    else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      // 起始行与结束行相同的块（单行对象/数组）不产生折叠
      if (open && open.line < line) folds.push({ start: open.line, end: line, depth: open.depth });
    }
    i++;
  }
  return folds;
}
