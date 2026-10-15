import {
  parseJson,
  stringifyJson,
  childNodes,
  searchJson,
  diffJson,
  unescapeText,
  highlightJsonHtml,
  computeJsonFolds,
  HIGHLIGHT_CHAR_LIMIT,
  HIGHLIGHT_LINE_LIMIT,
} from "./core.mjs";
import { queryJson, jsonStats, toTypeScript } from "./extra.mjs";

const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);
let parsed = null,
  result = "",
  differences = [],
  selectedView = "text",
  activeMode = "format",
  debounce;
const kit = PluginKit.create({
  title: "JSON 工具",
  quickPlaceholder: "粘贴 JSON，Enter 格式化",
  height: 510,
  defaults: { indent: "2", defaultView: "text", wrapLines: true },
  onQuery(value) {
    $("input").value = value;
    invalidate();
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (value.trim()) transform("format", false);
    }, 300);
  },
  onAction(action) {
    if (action === "submit") transform("format");
    else if (action === "clear") clear();
  },
});

const INDENT_UNIT = (value) => (value === "tab" ? "\t" : Number(value) || 2);

function inputStats() {
  $("input-size").textContent = new Blob([$("input").value]).size + " B";
}
function invalidate() {
  parsed = null;
  result = "";
  $("output").value = "";
  foldState.clear();
  codeRows = [];
  $("code-render").innerHTML = "";
  $("code-render").hidden = true;
  $("code-tools").hidden = true;
  $("output").hidden = false;
  $("fold-hint").textContent = "";
  $("ts-output").textContent = "";
  $("error").textContent = "";
  $("tree").replaceChildren();
  $("query-results").replaceChildren();
  $("stats-cards").replaceChildren();
  $("stats-keys").replaceChildren();
  $("stats-types").replaceChildren();
  $("stats").textContent = "保留数字原始精度";
  $("result-size").textContent = "离线处理 · 最大 8 MB";
  updateEmptyState();
  inputStats();
}
function updateEmptyState() {
  const show = !$("output").value && !selectedViewDirty();
  $("result-empty").hidden = !show;
}
function selectedViewDirty() {
  if (selectedView === "tree") return $("tree").childElementCount > 0;
  if (selectedView === "query") return $("query-results").childElementCount > 0;
  if (selectedView === "ts") return !!$("ts-output").textContent;
  if (selectedView === "stats") return $("stats-cards").childElementCount > 0;
  if (selectedView === "diff") return $("diff-results").childElementCount > 0;
  return false;
}
function showEditor(name) {
  document.documentElement.dataset.editor = name;
  $("show-source").setAttribute("aria-pressed", String(name === "source"));
  $("show-result").setAttribute("aria-pressed", String(name === "result"));
}
function error(e) {
  $("error").textContent = e.message;
  result = "";
  $("output").value = "";
  foldState.clear();
  codeRows = [];
  $("code-render").innerHTML = "";
  $("code-render").hidden = true;
  $("code-tools").hidden = true;
  $("output").hidden = false;
  $("fold-hint").textContent = "";
  updateEmptyState();
  if (Number.isInteger(e.position)) {
    showEditor("source");
    $("input").focus();
    $("input").setSelectionRange(e.position, e.position + 1);
  }
}
function getParsed() {
  parsed = parseJson($("input").value);
  const s = parsed.stats;
  $("stats").textContent = `${s.nodes} 节点 · ${s.keys} 键 · ${s.maxDepth} 层`;
  return parsed;
}

/* ── 模式执行（格式化/压缩/排序/校验/转义/反转义） ── */
function transform(action, switchEditor = true) {
  $("error").textContent = "";
  activeMode = action;
  for (const b of document.querySelectorAll("#mode-switch [data-action]"))
    b.classList.toggle("active", b.dataset.action === action);
  if (!$("input").value.trim()) return;
  try {
    const input = $("input").value;
    if (new Blob([input]).size > 8 * 1024 * 1024)
      throw new Error("输入超过 8 MB");
    if (new Blob([input]).size > 2 * 1024 * 1024)
      kit.toast("输入超过 2 MB，处理可能需要片刻", "info");
    if (action === "escape") result = JSON.stringify(input).slice(1, -1);
    else if (action === "unescape") result = unescapeText(input);
    else {
      const p = getParsed();
      result = stringifyJson(
        p.root,
        action === "minify" ? 0 : INDENT_UNIT($("indent").value),
        action === "sort",
      );
      if (action === "check")
        kit.toast("JSON 有效，数字 token 已保留", "success");
    }
    $("output").value = result;
    $("result-size").textContent =
      new Blob([result]).size + " B · " + result.length + " 字符";
    if (switchEditor) showEditor("result");
    updateEmptyState();
    renderCode();
    refreshActiveView();
  } catch (e) {
    parsed = null;
    error(e);
  }
}
function refreshActiveView() {
  if (selectedView === "tree") renderTree();
  else if (selectedView === "query") runQuery();
  else if (selectedView === "ts") renderTs();
  else if (selectedView === "stats") renderStats();
}

/* ── 文本视图：高亮 + 行号 + 结构折叠 ── */
const JSON_OUTPUT_MODES = ["format", "sort", "check", "minify"];
let codeHighlight = true;
const foldState = new Map(); // startLine -> true（折叠中）
let codeRows = [];
let codeFoldsByStart = new Map(); // startLine -> folds[]

function renderCode() {
  const box = $("code-render"),
    tools = $("code-tools");
  const lines = result ? result.split("\n") : [];
  const usable =
    codeHighlight &&
    parsed &&
    JSON_OUTPUT_MODES.includes(activeMode) &&
    lines.length > 0 &&
    lines.length <= HIGHLIGHT_LINE_LIMIT &&
    result.length <= HIGHLIGHT_CHAR_LIMIT;
  if (!usable) {
    box.hidden = true;
    tools.hidden = true;
    $("output").hidden = false;
    foldState.clear();
    return;
  }
  const html = highlightJsonHtml(result);
  const folds = computeJsonFolds(result) || [];
  if (!html) {
    box.hidden = true;
    tools.hidden = true;
    $("output").hidden = false;
    return;
  }
  $("output").hidden = true;
  box.hidden = false;
  tools.hidden = false;
  foldState.clear();
  // 超过 120 行的大结果默认收拢到第 2 层，小结果保持全展开
  if (lines.length > 120)
    for (const f of folds) if (f.depth >= 2) foldState.set(f.start, true);
  codeFoldsByStart = new Map();
  for (const f of folds) {
    if (!codeFoldsByStart.has(f.start)) codeFoldsByStart.set(f.start, []);
    codeFoldsByStart.get(f.start).push(f);
  }
  box.innerHTML = html
    .split("\n")
    .map((lc, i) => {
      const hasFold = codeFoldsByStart.has(i);
      const folded = foldState.has(i);
      const btn = hasFold
        ? `<button class="fold-btn" data-fold="${i}" aria-expanded="${!folded}" aria-label="折叠第 ${i + 1} 行的块" tabindex="-1"></button>`
        : `<span class="fold-sp"></span>`;
      const ell = hasFold
        ? `<span class="fold-ell"${folded ? "" : " hidden"}> ⋯ ${
            Math.max(...codeFoldsByStart.get(i).map((f) => f.end)) - i
          } 行</span>`
        : "";
      return `<span class="cl${folded ? " folded" : ""}" data-l="${i}"><span class="ln">${i + 1}</span>${btn}<span class="lc">${lc || " "}</span>${ell}</span>`;
    })
    .join("");
  codeRows = [...box.children];
  applyFoldState();
  const collapsedCount = foldState.size;
  $("fold-hint").textContent = collapsedCount
    ? `已折叠 ${collapsedCount} 处`
    : folds.length
      ? `${folds.length} 处可折叠`
      : "";
}
function applyFoldState() {
  const collapsed = [...codeFoldsByStart.entries()].filter(([start]) =>
    foldState.has(start),
  );
  codeRows.forEach((row, i) => {
    let hide = false;
    for (const [start, folds] of collapsed)
      if (folds.some((f) => i > f.start && i <= f.end)) {
        hide = true;
        break;
      }
    row.hidden = hide;
  });
  for (const [start] of codeFoldsByStart) {
    const folded = foldState.has(start);
    const row = codeRows[start];
    row.classList.toggle("folded", folded);
    const btn = row.querySelector(".fold-btn");
    if (btn) btn.setAttribute("aria-expanded", String(!folded));
    const ell = row.querySelector(".fold-ell");
    if (ell) ell.hidden = !folded;
  }
}
$("code-render").addEventListener("click", (e) => {
  const btn = e.target.closest(".fold-btn");
  if (!btn) return;
  const start = Number(btn.dataset.fold);
  if (foldState.has(start)) foldState.delete(start);
  else foldState.set(start, true);
  applyFoldState();
  $("fold-hint").textContent = foldState.size
    ? `已折叠 ${foldState.size} 处`
    : "全展开";
});
$("hl-toggle").onclick = () => {
  codeHighlight = !codeHighlight;
  $("hl-toggle").classList.toggle("active", codeHighlight);
  $("hl-toggle").setAttribute("aria-pressed", String(codeHighlight));
  renderCode();
};
$("fold-none").onclick = () => {
  foldState.clear();
  applyFoldState();
  $("fold-hint").textContent = "全展开";
};
for (const b of document.querySelectorAll("[data-fold-depth]"))
  b.onclick = () => {
    const depth = Number(b.dataset.foldDepth);
    foldState.clear();
    for (const [, folds] of codeFoldsByStart)
      for (const f of folds) if (f.depth >= depth) foldState.set(f.start, true);
    applyFoldState();
    $("fold-hint").textContent = `已折叠 ${foldState.size} 处`;
  };

/* ── 树视图 ── */
function makeNode(item) {
  const children = childNodes(item.node, item.path);
  const wrapper = document.createElement(children.length ? "details" : "div");
  wrapper.className = "tree-node";
  const line = document.createElement(children.length ? "summary" : "span");
  const name = document.createElement("span");
  name.textContent = item.label + ": ";
  const value = document.createElement("span");
  value.className = "node-value";
  value.textContent = children.length
    ? (item.node.kind === "array" ? "[" : "{") +
      children.length +
      (item.node.kind === "array" ? "]" : "}")
    : stringifyJson(item.node, 0);
  const copyButton = document.createElement("button");
  copyButton.className = "path-copy";
  copyButton.textContent = "路径";
  copyButton.title = item.path || "(根路径)";
  copyButton.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    copy(item.path || "");
  };
  line.append(name, value, copyButton);
  wrapper.append(line);
  if (children.length) {
    let rendered = false;
    const load = () => {
      if (rendered) return;
      rendered = true;
      let at = 0;
      const more = document.createElement("button");
      more.textContent = "继续加载 100 项";
      const add = () => {
        more.remove();
        const end = Math.min(children.length, at + 100);
        while (at < end) wrapper.append(makeNode(children[at++]));
        if (at < children.length) wrapper.append(more);
      };
      more.onclick = add;
      add();
    };
    wrapper._load = load; // 全部展开时同步调用，不等待异步 toggle 事件
    wrapper.addEventListener("toggle", load);
  }
  return wrapper;
}
function expandAllTree() {
  if (!parsed) return;
  if (parsed.stats.nodes > 20000) {
    kit.toast(`共 ${parsed.stats.nodes} 个节点，过多已跳过全部展开`, "warn");
    return;
  }
  let guard = 0;
  // 每轮打开一层；_load 同步物化子节点，下一轮即可发现更深层的 details
  const openRound = () => {
    const closed = $("tree").querySelectorAll("details:not([open])");
    if (!closed.length || guard++ > 80) return;
    for (const d of closed) {
      d.open = true;
      d._load?.();
    }
    openRound();
  };
  openRound();
}
function renderTree() {
  $("tree").replaceChildren();
  try {
    if (!parsed) getParsed();
    const query = $("search").value.trim();
    if (query) {
      const matches = searchJson(parsed.root, query);
      $("search-count").textContent = matches.length + " 项";
      for (const item of matches.slice(0, 500)) {
        const button = document.createElement("button");
        button.className = "search-row";
        const path = document.createElement("small");
        path.textContent = item.path || "/";
        const preview = document.createElement("span");
        const full = stringifyJson(item.node, 0);
        preview.textContent =
          full.slice(0, 200) + (full.length > 200 ? "…" : "");
        button.append(path, preview);
        button.onclick = () => copy(full);
        $("tree").append(button);
      }
      if (matches.length > 500) {
        const note = document.createElement("p");
        note.className = "query-empty";
        note.textContent = "仅展示前 500 项，请缩小搜索范围。";
        $("tree").append(note);
      }
    } else {
      $("search-count").textContent = "";
      const root = makeNode({ label: "$", path: "", node: parsed.root });
      $("tree").append(root);
      if (root.tagName === "DETAILS") root.open = true;
    }
  } catch (e) {
    error(e);
  }
}

/* ── 查询视图 ── */
function runQuery() {
  const box = $("query-results");
  box.replaceChildren();
  const query = $("query").value.trim();
  if (!query) {
    box.append(hintRow("输入路径后回车，例如 .users[*].name"));
    return;
  }
  try {
    if (!parsed) getParsed();
    const matches = queryJson(parsed.root, query);
    if (!matches.length) {
      box.append(hintRow("没有匹配的节点"));
      return;
    }
    for (const item of matches.slice(0, 500)) {
      const button = document.createElement("button");
      button.className = "query-row";
      const path = document.createElement("code");
      path.className = "q-path";
      path.textContent = "$" + item.path;
      const value = document.createElement("span");
      value.className = "q-value";
      const text = stringifyJson(item.node, 0);
      value.textContent = text.length > 300 ? text.slice(0, 300) + "…" : text;
      button.append(path, value);
      button.onclick = () => copy(text);
      box.append(button);
    }
    if (matches.length > 500) {
      const note = document.createElement("p");
      note.className = "query-empty";
      note.textContent = `共 ${matches.length} 项命中，仅展示前 500 项。`;
      box.append(note);
    }
  } catch (e) {
    box.append(hintRow(e.message));
  }
}
function hintRow(text) {
  const p = document.createElement("p");
  p.className = "query-empty";
  p.textContent = text;
  return p;
}

/* ── TS 类型视图 ── */
function renderTs() {
  try {
    if (!parsed) getParsed();
    $("ts-output").textContent = toTypeScript(parsed.root, {
      rootName: $("ts-root-name").value.trim() || "Root",
    });
  } catch (e) {
    $("ts-output").textContent = "";
    error(e);
  }
}

/* ── 统计视图 ── */
const TYPE_LABELS = [
  ["object", "对象"],
  ["array", "数组"],
  ["string", "字符串"],
  ["number", "数字"],
  ["boolean", "布尔"],
  ["null", "空值"],
];
function renderStats() {
  try {
    if (!parsed) getParsed();
    const stats = jsonStats(parsed.root);
    const cards = [
      [parsed.stats.nodes, "节点"],
      [parsed.stats.keys, "键"],
      [parsed.stats.maxDepth, "最大深度"],
      [formatBytes(new Blob([$("input").value]).size), "输入体积"],
      [stats.maxArrayLength, "最长数组"],
      [stats.distinctKeys, "去重键数"],
    ];
    $("stats-cards").replaceChildren(
      ...cards.map(([value, label]) => {
        const card = document.createElement("div");
        card.className = "stat-card";
        const b = document.createElement("b");
        b.textContent = String(value);
        const span = document.createElement("span");
        span.textContent = label;
        card.append(b, span);
        return card;
      }),
    );
    $("stats-keys").replaceChildren(
      ...(stats.topKeys.length
        ? stats.topKeys.map(([key, count]) => {
            const li = document.createElement("li");
            const k = document.createElement("span");
            k.className = "k";
            k.textContent = key;
            const v = document.createElement("span");
            v.className = "v";
            v.textContent = "× " + count;
            li.append(k, v);
            return li;
          })
        : [emptyLi("暂无对象键")]),
    );
    $("stats-types").replaceChildren(
      ...TYPE_LABELS.filter(([kind]) => stats.counts[kind]).map(([kind, label]) => {
        const li = document.createElement("li");
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = label;
        const v = document.createElement("span");
        v.className = "v";
        v.textContent = String(stats.counts[kind]);
        li.append(k, v);
        return li;
      }),
    );
  } catch (e) {
    error(e);
  }
}
function emptyLi(text) {
  const li = document.createElement("li");
  li.className = "stat-empty";
  li.textContent = text;
  return li;
}
function formatBytes(size) {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / 1024 / 1024).toFixed(2) + " MB";
}

/* ── 视图切换 ── */
function view(name) {
  selectedView = name;
  document.querySelectorAll("[data-content]").forEach((el) => {
    el.hidden = el.dataset.content !== name;
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((el) => {
      el.classList.toggle("active", el.dataset.view === name);
      el.setAttribute("aria-pressed", String(el.dataset.view === name));
    });
  $("result-empty").hidden = true;
  if (name === "tree" && $("input").value.trim()) renderTree();
  updateEmptyState();
}

/* ── 差异 ── */
function compare() {
  $("error").textContent = "";
  try {
    differences = diffJson(
      getParsed().root,
      parseJson($("compare").value).root,
    );
    $("diff-results").replaceChildren();
    if (!differences.length) {
      const p = document.createElement("p");
      p.className = "diff-empty";
      p.textContent = "两份 JSON 相同（忽略对象键顺序）";
      $("diff-results").append(p);
    }
    for (const item of differences.slice(0, 1000)) {
      const row = document.createElement("article");
      row.className = "diff-row";
      const title = document.createElement("strong");
      title.textContent = item.type + " · " + item.path;
      const before = document.createElement("pre");
      before.textContent = "− " + item.before;
      const after = document.createElement("pre");
      after.className = "after";
      after.textContent = "+ " + item.after;
      row.append(title, before, after);
      $("diff-results").append(row);
    }
    if (differences.length > 1000) {
      const p = document.createElement("p");
      p.textContent = `共 ${differences.length} 处差异，显示前 1000 项；复制可取得全部。`;
      $("diff-results").append(p);
    }
  } catch (e) {
    differences = [];
    $("diff-results").textContent = "";
    $("error").textContent = "比较失败：" + e.message;
  }
}

/* ── 通用动作 ── */
function clear() {
  $("input").value = "";
  $("compare").value = "";
  $("diff-results").textContent = "";
  $("query").value = "";
  differences = [];
  invalidate();
  showEditor("source");
  $("input").focus();
}
document.querySelectorAll("[data-action]").forEach((b) => {
  b.onclick = () => transform(b.dataset.action);
});
document.querySelectorAll("[data-view]").forEach((b) => {
  b.onclick = () => view(b.dataset.view);
});
$("input").oninput = invalidate;
$("search").oninput = () => {
  clearTimeout(debounce);
  debounce = setTimeout(renderTree, 180);
};
$("query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runQuery();
  }
});
$("query-run").onclick = runQuery;
$("ts-root-name").addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(renderTs, 200);
});
$("ts-copy").onclick = () => {
  const text = $("ts-output").textContent;
  if (text) copy(text);
  else kit.toast("先在输入中提供 JSON", "info");
};
$("show-source").onclick = () => showEditor("source");
$("show-result").onclick = () => showEditor("result");
$("clear").onclick = clear;
$("copy").onclick = () =>
  result ? copy(result) : kit.toast("先生成结果", "info");
$("save").onclick = () => result && saveText("formatted.json", result);
$("refill").onclick = () => {
  if (!result) return;
  $("input").value = result;
  invalidate();
  showEditor("source");
};
$("paste").onclick = async () => {
  try {
    $("input").value = await api.clipboard.readText();
    invalidate();
    transform("format");
  } catch (e) {
    kit.toast("无法读取剪贴板：" + e.message, "error");
  }
};
$("compare-run").onclick = compare;
$("tree-expand").onclick = expandAllTree;
$("tree-collapse").onclick = () =>
  $("tree").querySelectorAll("details[open]").forEach((d) => (d.open = false));
$("diff-copy").onclick = () => copy(JSON.stringify(differences, null, 2));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    transform("format");
  }
});
api?.onEnter?.(({ payload }) => {
  const text = typeof payload === "string" ? payload : payload?.text;
  if (typeof text === "string" && text) {
    $("input").value = text;
    invalidate();
    transform("format");
  } else $("input").focus();
});
await kit.ready;
$("indent").value = String(kit.settings.indent || 2);
PluginKit.upgradeSelects(); // 纯 .value 赋值不触发 change，手动同步自定义下拉标签
view(kit.settings.defaultView === "tree" ? "tree" : "text");
for (const id of ["input", "output"])
  $(id).wrap = kit.settings.wrapLines === false ? "off" : "soft";
kit.onSettings((settings) => {
  $("indent").value = String(settings.indent || 2);
  PluginKit.upgradeSelects();
  for (const id of ["input", "output"])
    $(id).wrap = settings.wrapLines === false ? "off" : "soft";
});

function copy(text) {
  return kit.copy(text).catch((error) => {
    kit.toast(error.message, "error");
    return false;
  });
}
function saveText(name, content) {
  return kit.saveText(name, content).catch((error) => {
    kit.toast(error.message, "error");
    return null;
  });
}
