import { calculate, formatNumber, parseAssignment, isVariableName, CONSTANTS } from "./core.mjs";
const api = window.enest || window.zapi;
const $ = (id) => document.getElementById(id);
const VARS_KEY = "calculator.vars.v1";
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
    if (action === "submit") confirmEntry();
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
  vars = {},
  current = null,
  degrees = false;

const fmt = (value) => formatNumber(value, kit.settings.precision, { group: display.group });
const display = { group: true };

function compute() {
  try {
    const source = $("expr").value;
    const assign = parseAssignment(source);
    const target = assign ? assign.expr : source;
    current = calculate(target, { ans, memory, degrees, vars });
    if (assign) $("result").textContent = `${assign.name} = ` + fmt(current);
    else $("result").textContent = current == null ? "即输即算" : fmt(current);
    $("result").className = "";
    $("copy").disabled = current == null;
  } catch (error) {
    current = null;
    $("result").textContent = error.message;
    $("result").className = "error";
    $("copy").disabled = true;
  }
  if (Object.keys(vars).length) $("memory-value").textContent = "M = " + fmt(memory) + " · " + Object.entries(vars).map(([k, v]) => `${k}=${fmt(v)}`).join(" ");
  else $("memory-value").textContent = "M = " + fmt(memory);
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
    const expression = document.createElement("span");
    expression.className = "expression";
    expression.textContent = r.expr + " =";
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = r.result;
    recall.append(expression, value);
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
function confirmEntry() {
  compute();
  if (current == null) return;
  const source = $("expr").value.trim();
  const assign = parseAssignment(source);
  const expr = assign ? assign.expr : source;
  const result = fmt(current);
  const previous = history.find((r) => r.expr === source && r.result === result);
  history = history.filter((r) => r !== previous);
  history.unshift({
    id: previous?.id || crypto.randomUUID(),
    expr: source,
    result,
    favorite: previous?.favorite || false,
    at: Date.now(),
  });
  const limit = Math.max(20, Math.min(500, Number(kit.settings.historyLimit) || 100));
  let kept = 0;
  history = history.filter((r) => r.favorite || ++kept <= limit);
  ans = current;
  if (assign) {
    vars[assign.name] = current;
    kit.save(VARS_KEY, vars).catch(() => {});
  }
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
  "g",
  "=",
];
for (const key of keys) {
  const b = document.createElement("button");
  b.textContent = key;
  if (key === "=") b.className = "equal";
  if (key === "π" || key === "g") b.title = key === "π" ? "圆周率" : "重力加速度 9.80665";
  b.onclick = () => {
    if (key === "=") confirmEntry();
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
    } else confirmEntry();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  }
};
$("copy").onclick = () =>
  current != null && copy(fmt(current));
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
$("group-toggle").onclick = () => {
  display.group = !display.group;
  $("group-toggle").textContent = display.group ? "千分位" : "原始";
  $("group-toggle").setAttribute("aria-pressed", String(display.group));
  render();
  compute();
};
document.querySelectorAll("[data-insert]").forEach((b) => {
  b.onclick = () => insert(b.dataset.insert);
});
$("memory-add").onclick = () => {
  compute();
  if (current != null) memory += current;
  $("memory-value").textContent = "M = " + fmt(memory);
  compute();
};
$("memory-clear").onclick = () => {
  memory = 0;
  $("memory-value").textContent = "M = " + fmt(memory);
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
const savedVars = await kit.load(VARS_KEY, {});
if (savedVars && typeof savedVars === "object" && !Array.isArray(savedVars)) {
  for (const [k, v] of Object.entries(savedVars))
    if (isVariableName(k) && Number.isFinite(Number(v))) vars[k] = Number(v);
}
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
