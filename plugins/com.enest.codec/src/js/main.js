import { MODES, convert, convertLines } from "./core.mjs";
const api = window.enest || window.zapi,
  $ = (id) => document.getElementById(id);
let routed = false;
let mode = "base64",
  direction = "encode",
  debounce,
  result = "";
const kit = PluginKit.create({
  title: "编解码",
  quickPlaceholder: "输入待转换文本",
  height: 490,
  defaults: { defaultMode: "base64", liveConversion: true, strictUtf8: true },
  onQuery(value) {
    $("input").value = value;
    run();
  },
  onAction(action) {
    if (action === "submit") {
      run();
      if (result) copy(result);
    } else if (action === "clear") clear();
  },
});
const count = (text) =>
  text.length + " 字符 · " + new TextEncoder().encode(text).length + " B";
function reset() {
  result = "";
  $("output").value = "";
  $("copy").disabled = true;
  $("save").disabled = true;
  $("out-size").textContent = "";
}
function updateMode() {
  for (const b of $("modes").children) {
    b.classList.toggle("active", b.dataset.mode === mode);
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }
  $("direction").textContent =
    mode === "jwt" ? "查看内容" : direction === "encode" ? "编码 →" : "← 解码";
  $("direction").disabled = mode === "jwt";
  $("swap").disabled = mode === "jwt";
  $("mode-help").textContent =
    mode === "jwt"
      ? "只查看，不验证签名"
      : mode === "query"
        ? "解码 URL；编码二维字符串数组"
        : "UTF-8";
  $("input").placeholder =
    mode === "query"
      ? direction === "decode"
        ? "https://example.com/?key=value"
        : '[["key","value"]]'
      : mode === "jwt"
        ? "粘贴 JWT，离线查看 Header / Payload"
        : "输入或粘贴需要转换的内容";
}
function run() {
  clearTimeout(debounce);
  const text = $("input").value;
  $("in-size").textContent = text ? count(text) : "";
  $("error").textContent = "";
  reset();
  if (!text) return;
  try {
    const started = performance.now();
    if ($("batch").checked) {
      const rows = convertLines(text, mode, direction, {
        strictUtf8: kit.settings.strictUtf8 !== false,
      });
      result = rows
        .map((r) => (r.ok ? r.value : `[第 ${r.line} 行错误] ${r.value}`))
        .join("\n");
      $("status").textContent =
        rows.filter((r) => r.ok).length + "/" + rows.length + " 行成功";
    } else {
      result = convert(text, mode, direction, {
        strictUtf8: kit.settings.strictUtf8 !== false,
      });
      $("status").textContent =
        "本地转换 · " + (performance.now() - started).toFixed(1) + " ms";
    }
    $("output").value = result;
    $("out-size").textContent = count(result);
    $("copy").disabled = !result;
    $("save").disabled = !result;
  } catch (e) {
    $("error").textContent = "转换失败：" + e.message;
    $("status").textContent = "请检查输入内容";
  }
}
function clear() {
  $("input").value = "";
  $("in-size").textContent = "";
  $("error").textContent = "";
  reset();
  $("input").focus();
}
for (const [key, label] of Object.entries(MODES)) {
  const b = document.createElement("button");
  b.textContent = label;
  b.dataset.mode = key;
  b.onclick = () => {
    mode = key;
    if (mode === "jwt" || mode === "query") direction = "decode";
    updateMode();
    run();
  };
  $("modes").append(b);
}
$("direction").onclick = () => {
  direction = direction === "encode" ? "decode" : "encode";
  updateMode();
  run();
};
$("run").onclick = run;
$("clear").onclick = clear;
$("copy").onclick = () => result && copy(result);
$("save").onclick = () => result && saveText("codec-" + mode + ".txt", result);
$("swap").onclick = () => {
  if (!result) return;
  $("input").value = result;
  direction = direction === "encode" ? "decode" : "encode";
  updateMode();
  run();
};
$("input").oninput = () => {
  reset();
  $("error").textContent = "";
  $("in-size").textContent = count($("input").value);
  clearTimeout(debounce);
  if ($("live").checked) debounce = setTimeout(run, 220);
};
$("live").onchange = () => {
  if ($("live").checked) run();
};
$("batch").onchange = run;
$("paste").onclick = async () => {
  try {
    $("input").value = await api.clipboard.readText();
    run();
  } catch (e) {
    kit.toast("无法读取剪贴板：" + e.message, "error");
  }
};
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    run();
  }
});
api?.onEnter?.(({ code, payload }) => {
  if (code && MODES[code]) {
    routed = true;
    mode = code;
    direction = ["jwt", "query"].includes(mode) ? "decode" : direction;
    updateMode();
  }
  const text = typeof payload === "string" ? payload : payload?.text;
  if (text) {
    $("input").value = text;
    run();
  }
  $("input").focus();
});
await kit.ready;
if (!routed && MODES[kit.settings.defaultMode]) mode = kit.settings.defaultMode;
if (["jwt", "query"].includes(mode)) direction = "decode";
$("live").checked = kit.settings.liveConversion !== false;
updateMode();
run();
kit.onSettings(() => {
  $("live").checked = kit.settings.liveConversion !== false;
  run();
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
