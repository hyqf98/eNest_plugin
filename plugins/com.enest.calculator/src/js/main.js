import { calculate, formatNumber } from "./core.mjs";
const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const kit = PluginKit.create({
  title: "计算器",
  quickPlaceholder: "输入表达式，Enter 记录",
  height: 470,
  defaults: { precision: 12, historyLimit: 100, angleUnit: "rad" },
  onQuery: (value) => {
    $("expr").value = value;
    compute();
  },
  onAction: (action) => {
    if (action === "submit") confirm();
    else if (action === "clear") {
      $("expr").value = "";
      compute();
    } else move(action === "next" ? 1 : -1);
  },
});
let history = [],
  selected = -1,
  onlyFavorites = false,
  ans = 0,
  memory = 0,
  current = null,
  degrees = false;
function compute() {
  try {
    current = calculate($("expr").value, { ans, memory, degrees });
    $("result").textContent =
      current == null
        ? "即输即算"
        : formatNumber(current, kit.settings.precision);
    $("result").className = "";
    $("copy").disabled = current == null;
  } catch (error) {
    current = null;
    $("result").textContent = error.message;
    $("result").className = "error";
    $("copy").disabled = true;
  }
}
function records() {
  const q = $("history-search").value.toLowerCase();
  return history.filter(
    (r) =>
      (!onlyFavorites || r.favorite) &&
      (r.expr + " " + r.result).toLowerCase().includes(q),
  );
}
function render() {
  $("history-count").textContent = history.length ? String(history.length) : "";
  const rows = records();
  selected = Math.min(selected, rows.length - 1);
  $("history-list").replaceChildren();
  if (!rows.length) {
    $("history-list").innerHTML =
      '<p class="empty">还没有计算记录<br>输入表达式后按 Enter，随时回填继续计算。</p>';
    return;
  }
  rows.forEach((r, i) => {
    const row = document.createElement("article");
    row.className = "record" + (i === selected ? " selected" : "");
    const recall = document.createElement("button");
    recall.className = "recall";
    recall.innerHTML =
      '<span class="expression"></span><span class="value"></span>';
    recall.children[0].textContent = r.expr + " =";
    recall.children[1].textContent = r.result;
    recall.title = "回填表达式";
    recall.onclick = () => {
      $("expr").value = r.expr;
      compute();
      $("expr").focus();
    };
    const star = document.createElement("button");
    star.className = "star";
    star.textContent = r.favorite ? "已收藏" : "收藏";
    star.setAttribute("aria-pressed", String(r.favorite));
    star.onclick = () => {
      r.favorite = !r.favorite;
      persist();
      render();
    };
    const copyButton = document.createElement("button");
    copyButton.textContent = "复制";
    copyButton.onclick = () => copy(r.result);
    row.append(recall, star, copyButton);
    $("history-list").append(row);
  });
}
async function persist() {
  await kit
    .save("calculator.history.v1", history)
    .catch((e) => kit.toast("记录保存失败：" + e.message, "error"));
}
function confirm() {
  compute();
  if (current == null) return;
  const expr = $("expr").value.trim(),
    result = formatNumber(current, kit.settings.precision);
  const previous = history.find((r) => r.expr === expr && r.result === result);
  history = history.filter((r) => r !== previous);
  history.unshift({
    id: previous?.id || crypto.randomUUID(),
    expr,
    result,
    favorite: previous?.favorite || false,
    at: Date.now(),
  });
  const limit = Math.max(
    20,
    Math.min(500, Number(kit.settings.historyLimit) || 100),
  );
  let kept = 0;
  history = history.filter((r) => r.favorite || ++kept <= limit);
  ans = current;
  $("expr").value = result;
  kit.setQuery(result);
  selected = -1;
  persist();
  render();
  compute();
}
function move(delta) {
  const rows = records();
  if (!rows.length) return;
  selected = Math.max(0, Math.min(rows.length - 1, selected + delta));
  render();
  $("history-list")
    .querySelector(".selected")
    ?.scrollIntoView({ block: "nearest" });
}
function insert(value) {
  const input = $("expr");
  input.setRangeText(value, input.selectionStart, input.selectionEnd, "end");
  selected = -1;
  compute();
  input.focus();
}
const keys = [
  "sin(",
  "cos(",
  "tan(",
  "sqrt(",
  "^",
  "7",
  "8",
  "9",
  "/",
  "AC",
  "4",
  "5",
  "6",
  "*",
  "⌫",
  "1",
  "2",
  "3",
  "-",
  "(",
  "0",
  ".",
  "%",
  "+",
  ")",
  "log(",
  "ln(",
  "π",
  "e",
  "=",
];
for (const key of keys) {
  const b = document.createElement("button");
  b.textContent = key;
  if (key === "=") b.className = "equal";
  b.onclick = () => {
    if (key === "=") confirm();
    else if (key === "AC") {
      $("expr").value = "";
      compute();
    } else if (key === "⌫") {
      const el = $("expr");
      el.setRangeText(
        "",
        el.selectionStart === el.selectionEnd
          ? Math.max(0, el.selectionStart - 1)
          : el.selectionStart,
        el.selectionEnd,
        "end",
      );
      compute();
    } else insert(key);
  };
  $("keypad").append(b);
}
$("expr").oninput = () => {
  selected = -1;
  compute();
};
$("expr").onkeydown = (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    if (selected >= 0 && records()[selected]) {
      $("expr").value = records()[selected].expr;
      selected = -1;
      compute();
    } else confirm();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  }
};
$("copy").onclick = () =>
  current != null && copy(formatNumber(current, kit.settings.precision));
$("angle").onclick = () => {
  degrees = !degrees;
  $("angle").textContent = degrees ? "DEG" : "RAD";
  $("angle").setAttribute("aria-pressed", String(degrees));
  compute();
};
$("toggle-pad").onclick = () => {
  const open = $("keypad").classList.toggle("expanded");
  $("toggle-pad").setAttribute("aria-expanded", String(open));
};
document.querySelectorAll("[data-insert]").forEach((b) => {
  b.onclick = () => insert(b.dataset.insert);
});
$("memory-add").onclick = () => {
  compute();
  if (current != null) memory += current;
  $("memory-value").textContent = "M = " + formatNumber(memory);
  compute();
};
$("memory-clear").onclick = () => {
  memory = 0;
  $("memory-value").textContent = "M = 0";
  compute();
};
$("favorites").onclick = () => {
  onlyFavorites = !onlyFavorites;
  $("favorites").setAttribute("aria-pressed", String(onlyFavorites));
  selected = -1;
  render();
};
$("history-search").oninput = () => {
  selected = -1;
  render();
};
$("clear").onclick = () => {
  history = history.filter((r) => r.favorite);
  persist();
  render();
};
$("export").onclick = () =>
  saveText(
    "calculations.txt",
    records()
      .map((r) => r.expr + " = " + r.result)
      .join("\n"),
  );
api?.onEnter?.(({ payload }) => {
  const text = typeof payload === "string" ? payload : payload?.text;
  if (typeof text === "string" && text) {
    $("expr").value = text;
    compute();
  }
  $("expr").focus();
});
await kit.ready;
degrees = kit.settings.angleUnit === "deg";
$("angle").textContent = degrees ? "DEG" : "RAD";
$("angle").setAttribute("aria-pressed", String(degrees));
const loaded = await kit.load("calculator.history.v1", []);
history = Array.isArray(loaded)
  ? loaded
      .filter(
        (r) => r && typeof r.expr === "string" && typeof r.result === "string",
      )
      .slice(0, 1000)
  : [];
render();
compute();
kit.onSettings(compute);

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
