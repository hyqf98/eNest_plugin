import {
  parseJson,
  stringifyJson,
  childNodes,
  searchJson,
  diffJson,
  unescapeText,
} from "./core.mjs";
const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);
let parsed = null,
  result = "",
  differences = [],
  selectedView = "text",
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
function inputStats() {
  $("input-size").textContent = new Blob([$("input").value]).size + " B";
}
function invalidate() {
  parsed = null;
  result = "";
  $("output").value = "";
  $("error").textContent = "";
  $("tree").replaceChildren();
  $("stats").textContent = "保留数字原始精度";
  $("result-size").textContent = "离线处理 · 最大 8 MB";
  inputStats();
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
function transform(action, switchEditor = true) {
  $("error").textContent = "";
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
        action === "minify" ? 0 : Number($("indent").value),
        action === "sort",
      );
      if (action === "check")
        kit.toast("JSON 有效，数字 token 已保留", "success");
    }
    $("output").value = result;
    $("result-size").textContent =
      new Blob([result]).size + " B · " + result.length + " 字符";
    if (switchEditor) showEditor("result");
    if (selectedView === "tree") renderTree();
  } catch (e) {
    parsed = null;
    error(e);
  }
}
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
    wrapper.addEventListener("toggle", () => {
      if (!wrapper.open || rendered) return;
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
    });
  }
  return wrapper;
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
        note.className = "empty";
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
function view(name) {
  selectedView = name;
  document.querySelectorAll("[data-content]").forEach((el) => {
    el.hidden = el.dataset.content !== name;
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((el) =>
      el.setAttribute("aria-pressed", String(el.dataset.view === name)),
    );
  if (name === "tree" && $("input").value.trim()) renderTree();
}
function compare() {
  $("error").textContent = "";
  try {
    differences = diffJson(
      getParsed().root,
      parseJson($("compare").value).root,
    );
    $("diff-results").replaceChildren();
    if (!differences.length)
      $("diff-results").innerHTML =
        '<p class="empty">两份 JSON 相同（忽略对象键顺序）</p>';
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
function clear() {
  $("input").value = "";
  $("compare").value = "";
  $("diff-results").textContent = "";
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
view(kit.settings.defaultView === "tree" ? "tree" : "text");
for (const id of ["input", "output"])
  $(id).wrap = kit.settings.wrapLines === false ? "off" : "soft";
kit.onSettings((settings) => {
  $("indent").value = String(settings.indent || 2);
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
