import {
  FLAG_DEFS,
  CHEATSHEET,
  TEMPLATE_LIBRARY,
  templateGroups,
  compilePattern,
  collectMatches,
  groupRows,
  parseReplacement,
  replaceAll,
  diffSegments,
} from "./core.mjs";

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

const SAMPLE_TEXT = [
  "订单号：20260915，下单时间 2026-09-15 08:30。",
  "用户 alice@example.com 于 2026-10-01 注册。",
  "联系电话 13812345678，备用 15987654321。",
  "金额合计 1,299,000.00 元，见 https://example.com/invoice/2026。",
].join("\n");

let matches = [];
let activeIndex = -1;
let lastElapsed = 0;

/* ── 静态区块 ─────────────────────────── */
$("flags").innerHTML = FLAG_DEFS.map(
  (f) =>
    `<button type="button" data-flag="${f.key}" aria-pressed="false" title="${esc(f.detail)}">${f.key}<span class="flag-name">${esc(f.label)}</span></button>`,
).join("");
$("cheatsheet").innerHTML = CHEATSHEET.map(
  (group) =>
    `<h3>${esc(group.title)}</h3><table class="cheat-table"><tbody>` +
    group.rows
      .map(([token, desc]) => `<tr><td class="mono">${esc(token)}</td><td>${esc(desc)}</td></tr>`)
      .join("") +
    "</tbody></table>",
).join("");
$("template-list").innerHTML = templateGroups()
  .map(
    (group) =>
      `<h3>${esc(group.name)}</h3><ul class="template-group">` +
      group.items
        .map(
          (t) =>
            `<li><button type="button" class="template-item" data-tpl="${esc(t.body)}" data-sample="${esc(t.sample)}" title="${esc(t.body)}"><span class="tpl-name">${esc(t.name)}</span><span class="tpl-body mono">${esc(t.body)}</span></button></li>`,
        )
        .join("") +
      "</ul>",
  )
  .join("");

/* ── 渲染 ─────────────────────────── */
function render() {
  const source = $("pattern").value;
  const flags = currentFlags();
  const text = $("samples").value;
  clearError();
  matches = [];
  let error = null;
  const t0 = performance.now();
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
  lastElapsed = performance.now() - t0;
  if (error) {
    showError(error.message);
    matches = [];
  }
  $("run-stats").textContent = source
    ? error
      ? "表达式有误"
      : `${matches.length} 处匹配 · ${formatElapsed(lastElapsed)}`
    : "";
  renderHighlightView(text);
  renderMatchList();
  renderGroups();
  renderReplace(text);
  document.title = source && !error ? `正则工作台 · ${matches.length} 处匹配` : "正则工作台";
}

function formatElapsed(ms) {
  if (ms < 1) return "<1ms";
  if (ms < 100) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
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

/* 匹配高亮预览：文本 + <mark> 交错，点击 mark 反选列表项 */
function highlightHtml(text, activeIdx) {
  if (!text) return "";
  if (!matches.length) return esc(text);
  let html = "";
  let cursor = 0;
  matches.forEach((m, i) => {
    html += esc(text.slice(cursor, m.index));
    const textContent = esc(m.text) || "&#8203;";
    html +=
      i === activeIdx
        ? `<mark class="active" data-index="${m.index}">${textContent}</mark>`
        : `<mark data-index="${m.index}">${textContent}</mark>`;
    cursor = m.end;
  });
  html += esc(text.slice(cursor));
  return html;
}

function renderHighlightView(text) {
  $("highlight-view").innerHTML = highlightHtml(text, activeIndex);
}

function renderMatchList() {
  const list = $("match-list");
  $("match-count").textContent = matches.length ? `· ${matches.length} 处` : "";
  $("match-badge").textContent = matches.length ? String(matches.length) : "";
  if (!matches.length) {
    list.innerHTML = `<li class="empty-note">${
      $("pattern").value ? "没有匹配。检查表达式或标志位。" : "在左侧输入正则，或从模板库选一条试试。"
    }</li>`;
    return;
  }
  list.innerHTML = matches
    .map((m, i) => {
      const empty = m.text === "";
      return `<li data-index="${i}" class="${i === activeIndex ? "active" : ""}"><span class="idx mono">#${i + 1}</span><span class="match-text mono">${
        empty ? "<em>空匹配</em>" : esc(m.text)
      }</span><span class="range mono">行 ${m.line} · [${m.index}, ${m.end})</span></li>`;
    })
    .join("");
}

function renderGroups() {
  const box = $("groups");
  const which = $("group-which");
  const pick = matches[activeIndex >= 0 ? activeIndex : 0];
  const shown = pick ? (matches.indexOf(pick) >= 0 ? matches.indexOf(pick) : 0) : -1;
  if (shown < 0) {
    which.textContent = "";
    box.innerHTML = '<p class="empty-note">有匹配结果后，此处展开捕获分组。</p>';
    return;
  }
  which.textContent = `第 ${shown + 1} 处`;
  const rows = groupRows(pick);
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
  if (matches.length > 1) box.innerHTML += `<p class="empty-note">点击匹配列表可切换查看。</p>`;
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
$("highlight-view").addEventListener("click", (e) => {
  const mark = e.target.closest("mark[data-index]");
  if (!mark) return;
  const i = matches.findIndex((m) => m.index === Number(mark.dataset.index));
  if (i < 0) return;
  selectMatch(i, false);
});
$("match-list").addEventListener("click", (e) => {
  const row = e.target.closest("[data-index]");
  if (!row) return;
  selectMatch(Number(row.dataset.index), true);
});
function selectMatch(i, scrollHighlight) {
  activeIndex = i;
  const m = matches[i];
  if (!m) return;
  renderMatchList();
  renderHighlightView($("samples").value);
  renderGroups();
  if (scrollHighlight) {
    const mark = $("highlight-view").querySelector(`mark[data-index="${m.index}"]`);
    if (mark) mark.scrollIntoView({ block: "nearest" });
  }
  const row = $("match-list").children[i];
  if (row) row.scrollIntoView({ block: "nearest" });
  if (kit.mode === "quick") $("samples").focus();
}
$("copy-result").onclick = () => {
  const parts = parseReplacement($("replacement").value);
  kit.copy(replaceAll(matches, parts, $("samples").value)).catch((e) => kit.toast(e.message, "error"));
};
$("template-list").addEventListener("click", (e) => {
  const item = e.target.closest("[data-tpl]");
  if (!item) return;
  $("pattern").value = item.dataset.tpl;
  if (item.dataset.sample) $("samples").value = item.dataset.sample;
  closeDrawer($("snippets"), $("toggle-snippets"));
  render();
  $("pattern").focus();
});

/* ── 抽屉开关（模板库 / 速查表） ─────────────────────────── */
function openDrawer(drawer, toggle) {
  drawer.hidden = false;
  toggle?.setAttribute("aria-expanded", "true");
}
function closeDrawer(drawer, toggle) {
  drawer.hidden = true;
  toggle?.setAttribute("aria-expanded", "false");
}
$("toggle-sheet").onclick = () => {
  const sheet = $("sheet");
  sheet.hidden ? openDrawer(sheet, $("toggle-sheet")) : closeDrawer(sheet, $("toggle-sheet"));
};
$("close-sheet").onclick = () => closeDrawer($("sheet"), $("toggle-sheet"));
$("toggle-snippets").onclick = () => {
  const aside = $("snippets");
  aside.hidden ? openDrawer(aside, $("toggle-snippets")) : closeDrawer(aside, $("toggle-snippets"));
};
$("close-snippets").onclick = () => closeDrawer($("snippets"), $("toggle-snippets"));
for (const drawer of [$("sheet"), $("snippets")]) {
  drawer.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeDrawer(drawer, drawer === $("sheet") ? $("toggle-sheet") : $("toggle-snippets"));
    }
  });
}

/* ── 启动 ─────────────────────────── */
(async () => {
  await kit.ready;
  applyFlags();
  if (!$("samples").value.trim() && kit.mode === "shell") $("samples").value = SAMPLE_TEXT;
  render();
})();
render();
