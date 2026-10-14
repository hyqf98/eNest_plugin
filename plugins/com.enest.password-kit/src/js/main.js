import {
  CHARACTER_SETS,
  generatePassword,
  uuidV4,
  entropyEstimate,
} from "./core.mjs";
const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);
let kind = "password",
  values = [],
  history = [],
  masked = true;
const kit = PluginKit.create({
  title: "密码工具箱",
  quickPlaceholder: "输入长度，或输入 uuid",
  height: 520,
  defaults: {
    defaultLength: 16,
    avoidAmbiguous: false,
    maskResults: true,
    uuidUppercase: false,
    uuidHyphens: true,
  },
  onQuery(text) {
    if (/uuid/i.test(text)) changeKind("uuid");
    else if (/^\d{1,3}$/.test(text.trim())) {
      changeKind("password");
      setLength(Number(text));
    }
  },
  onAction(action) {
    if (action === "submit") generate(true);
    else if (action === "clear") {
      values = [];
      render();
    }
  },
});
function options() {
  return {
    length: Number($("length").value),
    sets: Object.keys(CHARACTER_SETS).filter((key) => $(key).checked),
    avoidAmbiguous: $("ambiguous").checked,
    exclude: $("exclude").value,
  };
}
function strength() {
  try {
    const bits = entropyEstimate(options());
    $("strength-bar").style.width = Math.min(100, bits / 1.28) + "%";
    $("strength-text").textContent =
      `字符池估计上限 ${bits} bits · 每类至少一个字符`;
    $("error").textContent = "";
    $("generate").disabled = false;
    $("generate-copy").disabled = false;
  } catch (e) {
    $("strength-text").textContent = "";
    $("strength-bar").style.width = "0%";
    if (kind === "password") {
      $("error").textContent = e.message;
      $("generate").disabled = true;
      $("generate-copy").disabled = true;
    }
  }
}
function setLength(value) {
  const n = Math.max(6, Math.min(128, Math.round(Number(value) || 16)));
  $("length").value = n;
  $("length-number").value = n;
  $("length-value").textContent = n;
  strength();
}
function changeKind(next) {
  if (next === kind) return;
  kind = next;
  document
    .querySelectorAll("[data-kind]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.kind === kind)),
    );
  $("password-options").hidden = kind !== "password";
  $("uuid-options").hidden = kind !== "uuid";
  $("mask").hidden = kind !== "password";
  $("history-details").hidden = kind !== "password";
  $("privacy").textContent =
    kind === "password"
      ? "密码仅在当前会话保留，关闭插件后清除"
      : "随机 UUID v4 · 本地生成";
  values = [];
  $("error").textContent = "";
  $("generate").disabled = false;
  $("generate-copy").disabled = false;
  if (kind === "password") strength();
  render();
}
function formatted() {
  if (kind === "password" || $("separator").value === "newline")
    return values.join("\n");
  if ($("separator").value === "json") return JSON.stringify(values, null, 2);
  return values.join(",");
}
function row(value, i, isHistory = false) {
  const b = document.createElement("button");
  b.className = "secret-row";
  const num = document.createElement("span");
  num.className = "number";
  num.textContent = String(i + 1).padStart(2, "0");
  const text = document.createElement("span");
  text.className = "secret";
  text.textContent =
    masked && (kind === "password" || isHistory)
      ? "•".repeat(Math.min(24, value.length))
      : value;
  const hint = document.createElement("span");
  hint.className = "action";
  hint.textContent = "复制";
  b.setAttribute("aria-label", "复制第 " + (i + 1) + " 条");
  b.append(num, text, hint);
  b.onclick = () => copy(value);
  return b;
}
function render() {
  $("results").replaceChildren();
  if (!values.length)
    $("results").innerHTML =
      '<p class="empty">点击生成，结果会显示在这里。<br>也可以直接「生成并复制」。</p>';
  values.forEach((v, i) => $("results").append(row(v, i)));
  $("result-count").textContent = values.length ? values.length + " 条" : "";
  $("copy-all").disabled = !values.length;
  $("history").replaceChildren();
  history.forEach((v, i) => $("history").append(row(v, i, true)));
  $("mask").textContent = masked ? "显示内容" : "隐藏内容";
  $("mask").setAttribute("aria-pressed", String(masked));
}
function generate(copyAfter = false) {
  try {
    const count = Number($("count").value);
    if (!Number.isInteger(count) || count < 1 || count > 100)
      throw new Error("数量应为 1–100 的整数");
    values = Array.from({ length: count }, () =>
      kind === "password"
        ? generatePassword(options())
        : uuidV4({
            uppercase: $("uppercase").checked,
            hyphens: $("hyphens").checked,
          }),
    );
    if (kind === "password") history = [...values, ...history].slice(0, 8);
    $("error").textContent = "";
    render();
    if (copyAfter) copy(formatted());
  } catch (e) {
    values = [];
    render();
    $("error").textContent = e.message;
  }
}
document.querySelectorAll("[data-kind]").forEach((b) => {
  b.onclick = () => changeKind(b.dataset.kind);
});
document.querySelectorAll("[data-length]").forEach((b) => {
  b.onclick = () => setLength(b.dataset.length);
});
$("length").oninput = () => setLength($("length").value);
$("length-number").onchange = () => setLength($("length-number").value);
for (const key of [...Object.keys(CHARACTER_SETS), "ambiguous", "exclude"])
  $(key).addEventListener("input", strength);
$("mask").onclick = () => {
  masked = !masked;
  render();
};
$("generate").onclick = () => generate();
$("generate-copy").onclick = () => generate(true);
$("copy-all").onclick = () => values.length && copy(formatted());
$("clear-results").onclick = () => {
  values = [];
  render();
};
$("clear-history").onclick = (e) => {
  e.preventDefault();
  history = [];
  render();
};
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Enter" &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.isComposing &&
    e.target.tagName !== "BUTTON"
  ) {
    e.preventDefault();
    generate(e.shiftKey);
  }
});
api?.onEnter?.(({ code, payload }) => {
  const text = typeof payload === "string" ? payload : payload?.text;
  if (code === "uuid" || text === "uuid") changeKind("uuid");
  else if (code === "password") changeKind("password");
  if (/^\d{1,3}$/.test(text || "")) setLength(Number(text));
});
api?.onDestroy?.(() => {
  values = [];
  history = [];
  $("results").replaceChildren();
  $("history").replaceChildren();
});
await kit.ready;
setLength(kit.settings.defaultLength);
$("ambiguous").checked = Boolean(kit.settings.avoidAmbiguous);
masked = kit.settings.maskResults !== false;
$("uppercase").checked = Boolean(kit.settings.uuidUppercase);
$("hyphens").checked = kit.settings.uuidHyphens !== false;
strength();
render();
kit.onSettings((settings) => {
  setLength(settings.defaultLength);
  $("ambiguous").checked = Boolean(settings.avoidAmbiguous);
  masked = settings.maskResults !== false;
  $("uppercase").checked = Boolean(settings.uuidUppercase);
  $("hyphens").checked = settings.uuidHyphens !== false;
  strength();
  render();
});

function copy(text) {
  return kit.copy(text).catch((error) => {
    kit.toast(error.message, "error");
    return false;
  });
}
