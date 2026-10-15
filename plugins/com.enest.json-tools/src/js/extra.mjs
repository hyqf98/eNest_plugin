// JSON 扩展纯逻辑：简化路径查询、TypeScript 类型生成、统计面板。
// 只依赖 core.mjs 的 AST 结构（kind/entries/items/raw），可在 node 中直接自测。
import { childNodes, pointerPart } from "./core.mjs";

/* ── 路径查询（简化 JSONPath：$.a.b、[*]、[0]、[-1]、..name、*）────────── */
function tokenizeQuery(input) {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("查询为空，例如 $.users[*].name");
  let i = 0;
  if (text[i] === "$") i++;
  const steps = [];
  const readName = () => {
    let name = "";
    while (i < text.length && !".[]*".includes(text[i])) {
      name += text[i];
      i++;
    }
    return name.trim();
  };
  while (i < text.length) {
    const c = text[i];
    if (c === ".") {
      i++;
      if (text[i] === ".") {
        i++;
        if (text[i] === "*") {
          i++;
          steps.push({ type: "deepAll" });
          continue;
        }
        const name = readName();
        if (!name) throw new Error(`第 ${i} 个字符：.. 后需要键名`);
        steps.push({ type: "deep", name });
        continue;
      }
      if (text[i] === "*") {
        i++;
        steps.push({ type: "wild" });
        continue;
      }
      const name = readName();
      if (!name) throw new Error(`第 ${i} 个字符：. 后需要键名`);
      steps.push({ type: "child", name });
      continue;
    }
    if (c === "[") {
      const start = i++;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        i++;
        let name = "";
        while (i < text.length && text[i] !== quote) {
          if (text[i] === "\\") {
            i++;
            name += text[i] ?? "";
          } else name += text[i];
          i++;
        }
        if (text[i] !== quote)
          throw new Error(`第 ${start + 1} 个字符起：括号内字符串未闭合`);
        i++;
        if (text[i] !== "]") throw new Error("字符串键之后需要 ]");
        i++;
        steps.push({ type: "child", name });
        continue;
      }
      let body = "";
      while (i < text.length && text[i] !== "]") {
        body += text[i];
        i++;
      }
      if (text[i] !== "]")
        throw new Error(`第 ${start + 1} 个字符起：括号未闭合`);
      i++;
      body = body.trim();
      if (body === "*") steps.push({ type: "wild" });
      else if (/^-?\d+$/.test(body)) steps.push({ type: "index", n: Number(body) });
      else if (/^[A-Za-z_$][\w-]*$/.test(body)) steps.push({ type: "child", name: body });
      else throw new Error(`括号内容无法识别：${body || "(空)"}`);
      continue;
    }
    if (c === "*") {
      i++;
      steps.push({ type: "wild" });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      steps.push({ type: "child", name: readName() });
      continue;
    }
    throw new Error(`第 ${i + 1} 个字符无法识别：「${c}」`);
  }
  if (!steps.length) throw new Error("查询缺少路径步骤，例如 $.users[0].name");
  return steps;
}

const getChild = (node, name) =>
  node.kind === "object" ? node.entries.find((e) => e.key === name)?.value : undefined;

function* deepSearch(node, name, path = "") {
  for (const child of childNodes(node, path)) {
    if (node.kind === "object" && child.label === name) yield child;
    yield* deepSearch(child.node, name, child.path);
  }
}

function* deepAll(node, path = "") {
  for (const child of childNodes(node, path)) {
    yield child;
    yield* deepAll(child.node, child.path);
  }
}

/** 返回 [{ path, label, node }]；path 为 JSON Pointer（已按 RFC 6901 转义） */
export function queryJson(root, query) {
  const steps = tokenizeQuery(query);
  let current = [{ label: "$", path: "", node: root }];
  for (const step of steps) {
    const next = [];
    const seen = new Set();
    const pushWith = (item, label, node, foundPath) => {
      const path = foundPath ?? item.path + "/" + pointerPart(label);
      if (seen.has(path)) return;
      seen.add(path);
      next.push({ label: String(label), path, node });
    };
    for (const item of current) {
      if (step.type === "child") {
        const child = getChild(item.node, step.name);
        if (child) pushWith(item, step.name, child);
      } else if (step.type === "index") {
        if (item.node.kind !== "array") continue;
        const idx = step.n < 0 ? item.node.items.length + step.n : step.n;
        const child = item.node.items[idx];
        if (child) pushWith(item, String(idx), child);
      } else if (step.type === "wild") {
        for (const child of childNodes(item.node, item.path)) pushWith(item, child.label, child.node);
      } else if (step.type === "deep") {
        for (const found of deepSearch(item.node, step.name)) pushWith(item, found.label, found.node, found.path);
      } else if (step.type === "deepAll") {
        for (const found of deepAll(item.node, item.path)) pushWith(item, found.label, found.node, found.path);
      }
    }
    current = next;
    if (!current.length) break;
  }
  return current.slice(0, 2000);
}

/* ── 统计面板：类型分布、键 TopN、数组规模 ─────────────────────────────── */
export function jsonStats(root, { topKeys = 8 } = {}) {
  const counts = { object: 0, array: 0, string: 0, number: 0, boolean: 0, null: 0 };
  const keyCounts = new Map();
  let maxArrayLength = 0;
  let visited = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (++visited > 250000) break;
    if (counts[node.kind] !== undefined) counts[node.kind]++;
    if (node.kind === "object") {
      for (const entry of node.entries) {
        keyCounts.set(entry.key, (keyCounts.get(entry.key) || 0) + 1);
        stack.push(entry.value);
      }
    } else if (node.kind === "array") {
      maxArrayLength = Math.max(maxArrayLength, node.items.length);
      stack.push(...node.items);
    }
  }
  const top = [...keyCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topKeys);
  return {
    counts,
    distinctKeys: keyCounts.size,
    topKeys: top,
    maxArrayLength,
    visited,
  };
}

/* ── TypeScript interface 生成 ─────────────────────────────────────────── */
const SCALAR_TYPES = { string: "string", number: "number", boolean: "boolean", null: "null" };
const propKey = (key) =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
const singular = (hint) => {
  const word = String(hint || "").trim();
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
};

/**
 * 由 AST 生成 TS interface：对象展开为具名 interface（按结构去重复用），
 * 数组生成元素联合类型，空数组 unknown[]，混合数组 (A | B)[]。
 */
export function toTypeScript(root, { rootName = "Root", indent = "  " } = {}) {
  const interfaces = [];
  const bySignature = new Map();
  const usedNames = new Set();
  const pad = (depth) => indent.repeat(depth);

  const uniqueName = (base) => {
    let name = base || "Type";
    if (!/^[A-Za-z_$]/.test(name)) name = "T" + name;
    for (let n = 2; usedNames.has(name); n++) name = base + n;
    usedNames.add(name);
    return name;
  };
  const typeName = (hint) => {
    const cleaned = String(hint || "")
      .replace(/[^A-Za-z0-9_$]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ""))
      .replace(/^./, (c) => c.toUpperCase());
    return uniqueName(/^[A-Za-z]/.test(cleaned) ? cleaned : "Type");
  };

  const unionOf = (refs) => {
    const distinct = [...new Set(refs)];
    if (!distinct.length) return "unknown";
    return distinct.length === 1 ? distinct[0] : "(" + distinct.join(" | ") + ")";
  };

  function ref(node, hint) {
    if (SCALAR_TYPES[node.kind]) return SCALAR_TYPES[node.kind];
    if (node.kind === "array") {
      const elementRefs = node.items.map((item, i) =>
        ref(item, item.kind === "object" ? singular(hint) : hint + i),
      );
      if (!node.items.length) return "unknown[]";
      return unionOf(elementRefs) + "[]";
    }
    // object：先注册子类型（后序），再用子类型名组签名去重
    const members = new Map();
    const memberRefs = [];
    for (const entry of node.entries) {
      const childRef = ref(entry.value, entry.key);
      if (!members.has(entry.key)) {
        members.set(entry.key, []);
        memberRefs.push(entry.key);
      }
      members.get(entry.key).push(childRef);
    }
    const signature = memberRefs.map((key) => propKey(key) + ":" + unionOf(members.get(key))).join(";");
    const existing = bySignature.get(signature);
    if (existing) return existing;
    const name = typeName(singular(hint) || rootName);
    bySignature.set(
      signature,
      name,
    );
    interfaces.push({
      name,
      members: memberRefs.map((key) => ({ key, type: unionOf(members.get(key)) })),
    });
    return name;
  }

  const rootType = ref(root, rootName);
  const lines = [];
  for (const item of interfaces) {
    if (lines.length) lines.push("");
    lines.push(`export interface ${item.name} {`);
    if (!item.members.length) lines.push(`${pad(1)}[key: string]: unknown;`);
    for (const member of item.members) lines.push(`${pad(1)}${propKey(member.key)}: ${member.type};`);
    lines.push("}");
  }
  // 根为纯数组/标量时无对象 interface 主体，补根类型别名
  if (!interfaces.length || rootType.startsWith("(") || SCALAR_TYPES[root.kind] || rootType.endsWith("[]")) {
    const alias = typeName(rootName);
    if (!lines.length) return `export type ${alias} = ${rootType};\n`;
    return lines.join("\n") + `\n\nexport type ${alias} = ${rootType};\n`;
  }
  return lines.join("\n") + "\n";
}
