import {
  FLAG_DEFS,
  CHEATSHEET,
  DEFAULT_SNIPPETS,
  compilePattern,
  collectMatches,
  groupRows,
  parseReplacement,
  replaceAll,
  diffSegments,
} from "./core.mjs";

const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const esc = PluginKit.escape;

const kit = PluginKit.create({
  title: "正则工作台",
  quickPlaceholder: "输入正则，实时匹配下方样例",
  height: 480,
  defaults: { flags: "g" },
  onQuery: (value) => {
    $("pattern").value = String(value);
    render();
  },
  onAction: (action) => {
    if (action === "submit") $("samples").focus();
    if (action === "clear") {
      $("pattern").value = "";
      render();
    }
  },
});

const SNIPPET_KEY = "regex_snippets_v1";
let snippets = [...DEFAULT_SNIPPETS];
let matches = [];
let activeIndex = -1;

/* ── 初始化 ─────────────────────────── */
$("flags").innerHTML = FLAG_DEFS.map(
  (f) =>
    `<button data-flag="${f.key}" aria-pressed="false" title="${esc(f.label)}">${f.key}</button>`,
).join("");
$("cheatsheet").innerHTML = CHEATSHEET.map(
  (group) =>
    `<h3>${esc(group.title)}</h3><table class="cheat-table"><tbody>` +
    group.rows
      .map(
        ([token, desc]) =>
          `<td class="mono">${esc(token)}</td><td>${esc(desc)}</td>`,
      )
      .map((cells) => `<tr>${cells}</tr>`)
      .join("") +
    "</tbody></table>",
).join("");

(async () => {
  await kit.ready;
  const saved = await kit.load(SNIPPET_KEY, null);
  if (Array.isArray(saved) && saved.every((s) => s && typeof s.body === "string"))
    snippets = saved.slice(0, 200);
  renderSnippets();
  applyFlags();
  if (!$("samples").value.trim() && kit.mode === "shell") $("samples").value = SAMPLE_TEXT;
  render();
})();

const SAMPLE_TEXT = [
  "订单号：20260915，下单时间 2026-09-15 08:30。",
  "用户 alice@example.com 于 2026-10-01 注册。",
  "联系电话 13812345678，备用 15987654321。",
].join("\n");

/* ── 渲染 ─────────────────────────── */
function render() {
  const source = $("pattern").value;
  const flags = currentFlags();
  const text = $("samples").value;
  clearError();
  matches = [];
  let error = null;
  if (source) {
    let regexp;
    try {
      regexp = compilePattern(source, flags);
    } catch (e) {
      error = e;
    }
    if (regexp) {
      try {
        matches = collectMatches(regexp, text);
      } catch (e) {
        error = e;
      }
    }
  }
  if (error) {
    showError(error.message);
    matches = [];
  }
  renderHighlight(text);
  renderMatchList();
  renderGroups();
  renderReplace(text);
  document.title = source ? `正则工作台 · ${matches.length} 处匹配` : "正则工作台";
}

function currentFlags() {
  return [...$("flags").querySelectorAll('button[aria-pressed="true"]')]
    .map((b) => b.dataset.flag)
    .sort()
    .join("");
}

function applyFlags() {
  const saved = typeof kit.settings.flags === "string" ? kit.settings.flags : "g";
  for (const b of $("flags").querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(saved.includes(b.dataset.flag)));
}

function showError(message) {
  const bar = $("pattern-error");
  bar.textContent = "非法正则：" + message;
  bar.hidden = false;
}

function clearError() {
  $("pattern-error").hidden = true;
}

/* 样例区高亮：镜像 textarea 文本并铺底色 */
function renderHighlight(text) {
  const mirror = $("sample-highlight");
  mirror.innerHTML = "";
  if (!matches.length || !text) return;
  let html = "";
  let cursor = 0;
  for (const m of matches) {
    html += esc(text.slice(cursor, m.index));
    html += `<mark data-index="${m.index}">${esc(m.text) || "&#8203;"}</mark>`;
    cursor = m.end;
  }
  html += esc(text.slice(cursor));
  mirror.innerHTML = html;
}

function renderMatchList() {
  const list = $("match-list");
  $("match-count").textContent = matches.length ? `· ${matches.length} 处匹配` : "";
  $("match-badge").textContent = matches.length ? String(matches.length) : "";
  if (!matches.length) {
    list.innerHTML =
      '<li class="empty-note">没有匹配结果。在上方输入正则，或点击「填入示例」。</li>';
    return;
  }
  list.innerHTML = matches
    .map(
      (m, i) =>
        `<li data-index="${i}"><span class="idx">#${i + 1}</span>${esc(m.text) || "<em>空匹配</em>"}<span class="range">[${m.index}, ${m.end})</span></li>`,
    )
    .join("");
}

function renderGroups() {
  const box = $("groups");
  const first = matches[0];
  if (!first) {
    box.innerHTML = '<p class="empty-note">第一个匹配的分组会展开在这里。</p>';
    return;
  }
  const rows = groupRows(first);
  if (!rows.length) {
    box.innerHTML = '<p class="empty-note">当前正则没有捕获分组，用 ( ) 包住子模式试试。</p>';
    return;
  }
  box.innerHTML =
    '<table class="group-table"><thead><tr><th>引用</th><th class="num">组号</th><th>值</th></tr></thead><tbody>' +
    rows
      .map((r) => {
        const num = r.ref.startsWith("$<") ? "" : r.ref.slice(1);
        return `<tr><td class="mono">${esc(r.ref)}</td><td class="num">${esc(num)}</td><td class="mono">${esc(r.value ?? "未参与匹配")}</td></tr>`;
      })
      .join("") +
    "</tbody></table>";
  if (matches.length > 1)
    box.innerHTML += `<p class="empty-note">展示第 1 处匹配；共 ${matches.length} 处。</p>`;
}

function renderReplace(text) {
  const output = $("replace-output");
  const replacement = $("replacement").value;
  $("copy-result").disabled = !matches.length;
  if (!matches.length) {
    output.innerHTML = '<span class="empty-note">有匹配结果后展示替换 diff。</span>';
    return;
  }
  const parts = parseReplacement(replacement);
  const after = replaceAll(matches, parts, text);
  const segments = diffSegments(text, after);
  output.innerHTML = segments
    .map((s) =>
      s.type === "same"
        ? esc(s.value)
        : s.type === "ins"
          ? `<ins>${esc(s.value)}</ins>`
          : `<del>${esc(s.value)}</del>`,
    )
    .join("");
}

/* ── 片段库 ─────────────────────────── */
function renderSnippets() {
  const list = $("snippet-list");
  list.innerHTML = snippets.length
    ? snippets
        .map(
          (s, i) =>
            `<li data-snippet="${i}" title="${esc(s.body)}"><span class="name">${esc(s.name)}</span><button class="del" data-del="${i}" aria-label="删除 ${esc(s.name)}">×</button><span class="body mono">${esc(s.body)}</span></li>`,
        )
        .join("")
    : '<li class="empty-note">片段已清空，可在下方重新添加。</li>';
}

async function persistSnippets() {
  try {
    await kit.save(SNIPPET_KEY, snippets);
  } catch (e) {
    kit.toast(e.message, "error");
  }
}

/* ── 事件 ─────────────────────────── */
let debounce;
const scheduleRender = () => {
  clearTimeout(debounce);
  debounce = setTimeout(render, 120);
};
$("pattern").addEventListener("input", scheduleRender);
$("samples").addEventListener("input", scheduleRender);
$("replacement").addEventListener("input", scheduleRender);
$("flags").addEventListener("click", (e) => {
  const b = e.target.closest("[data-flag]");
  if (!b) return;
  b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
  render();
});
$("fill-sample").onclick = () => {
  $("samples").value = SAMPLE_TEXT;
  if (!$("pattern").value) $("pattern").value = "(\\d{4})-(\\d{2})-(\\d{2})";
  render();
};
$("match-list").addEventListener("click", (e) => {
  const row = e.target.closest("[data-index]");
  if (!row) return;
  activeIndex = Number(row.dataset.index);
  const mark = $("sample-highlight").querySelector(
    `mark[data-index="${matches[activeIndex]?.index}"]`,
  );
  if (mark) mark.scrollIntoView({ block: "nearest" });
  if (kit.mode === "quick") $("samples").focus();
});
$("copy-result").onclick = () => {
  const parts = parseReplacement($("replacement").value);
  kit.copy(replaceAll(matches, parts, $("samples").value)).catch((e) => kit.toast(e.message, "error"));
};
$("snippet-list").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    snippets.splice(Number(del.dataset.del), 1);
    void persistSnippets();
    renderSnippets();
    return;
  }
  const row = e.target.closest("[data-snippet]");
  if (!row) return;
  const snippet = snippets[Number(row.dataset.snippet)];
  if (!snippet) return;
  $("pattern").value = snippet.body;
  render();
  $("pattern").focus();
});
$("snippet-form").onsubmit = (e) => {
  e.preventDefault();
  const name = $("snippet-name").value.trim() || "未命名";
  const body = $("snippet-body").value;
  if (!body) {
    kit.toast("片段表达式不能为空");
    return;
  }
  try {
    compilePattern(body, "g");
  } catch (err) {
    kit.toast("表达式无法编译：" + err.message, "error");
    return;
  }
  snippets = [{ name, body }, ...snippets.filter((s) => s.body !== body)].slice(0, 200);
  $("snippet-name").value = "";
  $("snippet-body").value = "";
  void persistSnippets();
  renderSnippets();
};
$("snippet-reset").onclick = () => {
  snippets = [...DEFAULT_SNIPPETS];
  void persistSnippets();
  renderSnippets();
  kit.toast("已恢复默认片段", "success");
};
$("toggle-sheet").onclick = () => {
  const sheet = $("sheet");
  sheet.hidden = !sheet.hidden;
  $("toggle-sheet").setAttribute("aria-expanded", String(!sheet.hidden));
};
$("close-sheet").onclick = () => {
  $("sheet").hidden = true;
  $("toggle-sheet").setAttribute("aria-expanded", "false");
};
$("sheet").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    $("close-sheet").click();
  }
});
$("toggle-snippets").onclick = () => {
  const aside = $("snippets");
  const open = aside.style.display !== "none";
  aside.style.display = open ? "none" : "";
  $("toggle-snippets").setAttribute("aria-expanded", String(!open));
};
render();
