// assets/panel.js — 输入框上方的快捷指令面板
//
// 三块：指令列表（点或按数字键选）、底部选择条（已选指令挂在这，可 × 取消）、
// 收起/关闭。选择同步到后端，「发送时拼接」由 session/input 钩子完成——
// 面板只管挑，不管拼。
import { hana } from "./sdk.js";
import { getJson, postJson, clientLog } from "./app-api.js";

// 向宿主发就绪握手（hana.ready）：任何 App 页面都少不了它，
// 缺了宿主会把表面当「加载失败」，跟页面能不能跑无关。ready 只是把事件投出去，不阻塞。
try {
  await hana.ready();
} catch (err) {
  clientLog(`hana.ready 失败：${String(err?.message || err)}`);
}

const COLLAPSED_H = 36;
const EXPANDED_H = 300;
const POLL_MS = 2500;

const CHEV_UP =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>';
const CHEV_DOWN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

const root = document.getElementById("qc");
const listEl = document.getElementById("qc-list");
const chipsEl = document.getElementById("qc-chips");
const subEl = document.getElementById("qc-sub");
const emptyEl = document.getElementById("qc-empty");
const footEl = document.getElementById("qc-foot");
const barHintEl = document.getElementById("qc-bar-hint");
const toggleBtn = document.getElementById("qc-toggle");
const closeBtn = document.getElementById("qc-close");

let bound = null;
let sessionId = "";
let commands = [];
let pending = [];
let expanded = true;
let agentLabel = "";

function applyExpanded(v) {
  expanded = !!v;
  root.dataset.expanded = expanded ? "true" : "false";
  toggleBtn.innerHTML = expanded ? CHEV_UP : CHEV_DOWN;
}

async function setExpanded(v) {
  applyExpanded(v);
  if (!bound) return;
  try {
    await hana.inputPanel.setPresentation({ expanded, height: EXPANDED_H, collapsedHeight: COLLAPSED_H });
  } catch (err) {
    clientLog(`setPresentation 失败: ${String(err?.message || err)}`);
  }
}

/** 这一条当前显示的键帽：配了快捷键用配的，否则用列表序号。 */
function keycapOf(cmd, index) {
  return cmd.shortcut || String(index + 1);
}

function render() {
  const onIds = new Set(pending);
  listEl.innerHTML = "";

  commands.forEach((cmd, index) => {
    const li = document.createElement("li");
    li.className = "qc-item";
    li.setAttribute("aria-selected", onIds.has(cmd.id) ? "true" : "false");
    li.dataset.id = cmd.id;
    if (cmd.enabled === false) li.style.opacity = "0.55";

    const num = document.createElement("span");
    num.className = "qc-num";
    num.textContent = keycapOf(cmd, index);

    const main = document.createElement("div");
    main.className = "qc-main";
    const name = document.createElement("div");
    name.className = "qc-name";
    name.textContent = cmd.name;
    if (cmd.enabled === false) {
      const off = document.createElement("span");
      off.className = "qc-off";
      off.textContent = "已停用";
      name.appendChild(off);
    }
    const content = document.createElement("div");
    content.className = "qc-content";
    content.textContent = (cmd.content || "").replace(/\s+/g, " ").slice(0, 120) || "（空）";
    main.append(name, content);

    const pos = document.createElement("span");
    pos.className = "qc-pos";
    pos.dataset.pos = cmd.position;
    pos.textContent = cmd.position === "head" ? "头部" : "尾部";

    li.append(num, main, pos);
    li.addEventListener("click", () => void toggle(cmd.id));
    listEl.appendChild(li);
  });

  const empty = commands.length === 0;
  listEl.hidden = empty;
  emptyEl.hidden = !empty;
  if (empty) {
    emptyEl.innerHTML = "这个 agent 还没有快捷指令。<br>到 <b>设置 → Hana快捷指令</b> 里添加，或让助手用 quickcmd_upsert 工具写入。";
  }

  footEl.textContent = commands.length ? "数字键 1-9 快速选择 · 点条目加入 / 移出本次输入" : "";

  // 底部选择条：已选指令的 chip；没有就显示提示
  chipsEl.innerHTML = "";
  if (pending.length === 0) {
    barHintEl.textContent = "未选指令";
  } else {
    barHintEl.textContent = "";
    for (const id of pending) {
      const cmd = commands.find((c) => c.id === id);
      if (!cmd) continue;
      const chip = document.createElement("span");
      chip.className = "qc-chip";
      const label = document.createElement("span");
      label.textContent = cmd.name;
      const x = document.createElement("button");
      x.className = "qc-chip-x";
      x.type = "button";
      x.title = "取消这条指令";
      x.textContent = "✕";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        void toggle(cmd.id, "remove");
      });
      chip.append(label, x);
      chipsEl.appendChild(chip);
    }
  }

  subEl.textContent = commands.length ? `${agentLabel ? agentLabel + " · " : ""}共 ${commands.length} 条` : "";
}

async function loadState() {
  if (!sessionId) return;
  try {
    const data = await getJson(`state?sessionId=${encodeURIComponent(sessionId)}`);
    commands = Array.isArray(data.commands) ? data.commands : [];
    pending = Array.isArray(data.pending) ? data.pending : [];
    const who = data.agentId ? `agent ${data.agentId}${data.hasOwn ? "" : "·继承默认"}` : "未识别 agent";
    agentLabel = who;
    render();
  } catch (err) {
    clientLog(`state 失败: ${String(err?.message || err)}`);
  }
}

/** 只刷新「已选」状态，成本低，用于发现钩子那边消费掉的选择。 */
async function refreshPending() {
  if (!sessionId) return;
  try {
    const data = await getJson(`state?sessionId=${encodeURIComponent(sessionId)}`);
    const next = Array.isArray(data.pending) ? data.pending : [];
    const changed =
      next.length !== pending.length || next.some((id, i) => pending[i] !== id);
    commands = Array.isArray(data.commands) ? data.commands : commands;
    if (changed) {
      pending = next;
      render();
    }
  } catch {
    /* 轮询失败静默 */
  }
}

async function toggle(commandId, action = "toggle") {
  const has = pending.includes(commandId);
  const willAdd = action === "add" || (action === "toggle" && !has);
  // 先动界面，回包再校正
  pending = willAdd ? [...pending, commandId] : pending.filter((x) => x !== commandId);
  render();
  try {
    const res = await postJson("select", { sessionId, commandId, action });
    if (Array.isArray(res?.pending)) {
      pending = res.pending;
      render();
    }
  } catch (err) {
    clientLog(`select 失败: ${String(err?.message || err)}`);
    void loadState();
  }
}

async function clearAll() {
  pending = [];
  render();
  try {
    await postJson("clear", { sessionId });
  } catch (err) {
    clientLog(`clear 失败: ${String(err?.message || err)}`);
  }
}

async function closePanel() {
  if (!sessionId) return;
  try {
    await postJson("dismiss-panel", { sessionId });
  } catch (err) {
    clientLog(`close 失败: ${String(err?.message || err)}`);
  }
}

// ── 交互绑定 ─────────────────────────────────────────────
toggleBtn.addEventListener("click", () => void setExpanded(!expanded));
closeBtn.addEventListener("click", () => void closePanel());

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const key = e.key;
  if (!/^[1-9]$/.test(key)) return;

  // 优先按配置的快捷键匹配，其次当作列表序号
  let cmd = commands.find((c) => c.shortcut === key);
  if (!cmd) {
    const idx = Number(key) - 1;
    if (idx >= 0 && idx < commands.length) cmd = commands[idx];
  }
  if (!cmd) return;
  e.preventDefault();
  void toggle(cmd.id);
});

// 面板要能收到键盘，得让 iframe 文档拿到焦点
document.addEventListener("mousedown", () => {
  try { window.focus(); } catch { /* 无妨 */ }
});

// ── 宿主上下文 ───────────────────────────────────────────
hana.inputPanel.onContextChanged((context) => {
  bound = context || null;
  const nextSession = bound && typeof bound.sessionId === "string" ? bound.sessionId : "";
  const first = nextSession !== sessionId;
  sessionId = nextSession;
  applyExpanded(Boolean(bound?.presentation?.expanded ?? true));
  if (first && sessionId) {
    void loadState();
    try { window.focus(); } catch { /* 无妨 */ }
  }
});

applyExpanded(true);
try { window.focus(); } catch { /* 无妨 */ }

setInterval(() => void refreshPending(), POLL_MS);