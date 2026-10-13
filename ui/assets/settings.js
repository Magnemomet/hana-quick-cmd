// assets/settings.js — Hana快捷指令 设置页
//
// 两件事：
//   ① 允许 / 禁止 Agent 通过工具管理指令；
//   ② 按 agent 编辑指令表：名称、内容、拼接位置（头/尾）、快捷键（1-9）、启用。
// agent 没单独配过时，继承「默认（兜底）」那张表；一旦保存，就切到自己那份。
import { hana } from "./sdk.js";
import { getJson, postJson, clientLog } from "./app-api.js";

const DEFAULT_AGENT = "__default__";
const root = document.getElementById("root");
const toastEl = document.getElementById("toast");

let agents = [];
let prefs = { agentToolsEnabled: true, defaultPosition: "tail" };
let currentAgentId = DEFAULT_AGENT;
let items = [];
let inherited = false; // 当前 agent 是否在用兜底表
let dirty = false;

function toast(message) {
  toastEl.textContent = message;
  toastEl.dataset.show = "true";
  setTimeout(() => {
    toastEl.dataset.show = "false";
  }, 1600);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function newId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function markDirty() {
  dirty = true;
  render();
}

// ── 数据 ───────────────────────────────────────────────
async function loadAgentsAndPrefs() {
  const data = await getJson("state");
  agents = Array.isArray(data.agents) ? data.agents : [];
  prefs = data.prefs || prefs;
}

async function loadAgent(agentId) {
  // 参数名用 target 而不是 agentId：宿主要截 agentId 去解析 agent，不认得的值会让整个请求 404。
  const data = await getJson(`state?target=${encodeURIComponent(agentId)}`);
  agents = Array.isArray(data.agents) && data.agents.length ? data.agents : agents;
  prefs = data.prefs || prefs;
  currentAgentId = agentId;
  if (agentId === DEFAULT_AGENT) {
    items = structuredClone(data.defaultCommands || []);
    inherited = false;
  } else {
    const own = data.ownCommands;
    inherited = !Array.isArray(own);
    items = structuredClone(own || data.defaultCommands || []);
  }
  dirty = false;
  render();
}

// ── 渲染 ───────────────────────────────────────────────
function render() {
  root.innerHTML = "";

  const h1 = el("h1", "st-h1", "Hana快捷指令");
  const lede = el(
    "p",
    "st-lede",
    "在输入栏点 ⌘ 挑选指令，发送时按各自设置拼到本次用户提示词的头或尾。每个 agent 可以有自己的指令表。",
  );
  root.append(h1, lede);

  // ① Agent 工具开关
  const toolCard = el("section", "st-card");
  const row = el("div", "st-row");
  const sw = el("label", "st-switch");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = prefs.agentToolsEnabled !== false;
  cb.addEventListener("change", async () => {
    try {
      const res = await postJson("prefs", { agentToolsEnabled: cb.checked });
      prefs = res.prefs || prefs;
      toast(cb.checked ? "已允许 Agent 管理快捷指令" : "已禁止 Agent 管理快捷指令");
    } catch (err) {
      toast(`保存失败：${String(err?.message || err)}`);
      cb.checked = !cb.checked;
    }
  });
  sw.append(cb, el("span", null, "允许 Agent 通过工具写入 / 编辑 / 删除快捷指令"));
  row.append(sw);
  toolCard.append(row);
  toolCard.append(
    el(
      "div",
      "st-desc",
      "开着时，助手可调用 quickcmd_list / quickcmd_upsert / quickcmd_delete；关掉后这些工具立即撤下（输入栏的 ⌘ 入口不受影响）。",
    ),
  );
  root.append(toolCard);

  // ② agent 选择
  const pick = el("section", "st-card");
  const prow = el("div", "st-row");
  prow.append(el("span", "st-label", "配置对象"));
  const select = el("select", "st-select");
  const optDefault = document.createElement("option");
  optDefault.value = DEFAULT_AGENT;
  optDefault.textContent = "默认（未单独配置的 agent 继承这张表）";
  select.appendChild(optDefault);
  for (const a of agents) {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = a.name ? `${a.name}（${a.id}）` : a.id;
    select.appendChild(o);
  }
  select.value = currentAgentId;
  select.addEventListener("change", async () => {
    if (dirty && !confirm("有未保存的改动，切换将丢弃。继续？")) {
      select.value = currentAgentId;
      return;
    }
    await loadAgent(select.value);
  });
  prow.append(select);
  const spacer = el("span", "st-spacer");
  prow.append(spacer);
  pick.append(prow);

  if (currentAgentId !== DEFAULT_AGENT) {
    const noteRow = el("div", "st-row");
    if (inherited) noteRow.append(el("span", "st-tag", "当前继承默认表"));
    const resetBtn = el("button", "st-btn", "恢复继承默认");
    resetBtn.type = "button";
    resetBtn.disabled = inherited;
    resetBtn.addEventListener("click", async () => {
      if (!confirm("删除这个 agent 自己的指令表，回到继承默认？")) return;
      try {
        await postJson("agent/reset", { agentId: currentAgentId });
        await loadAgent(currentAgentId);
        toast("已恢复继承默认");
      } catch (err) {
        toast(`失败：${String(err?.message || err)}`);
      }
    });
    noteRow.append(resetBtn);
    pick.append(noteRow);
    if (inherited) {
      pick.append(el("div", "st-desc", "保存下面任意改动后，这个 agent 将改用属于它自己的指令表。"));
    }
  }
  root.append(pick);

  // ③ 指令列表
  const listCard = el("section", "st-card");
  const toolbar = el("div", "st-toolbar");
  toolbar.append(el("span", "st-label", `指令（${items.length}）`));
  const tSpacer = el("span", "st-spacer");
  const addBtn = el("button", "st-btn", "＋ 新增指令");
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    items.push({
      id: newId(),
      name: "新指令",
      content: "",
      position: prefs.defaultPosition || "tail",
      shortcut: "",
      enabled: true,
    });
    markDirty();
  });
  const saveBtn = el("button", "st-btn st-btn-primary", dirty ? "保存" : "已保存");
  saveBtn.type = "button";
  saveBtn.disabled = !dirty;
  saveBtn.addEventListener("click", () => void save());
  toolbar.append(tSpacer, addBtn, saveBtn);
  listCard.append(toolbar);

  if (items.length === 0) {
    listCard.append(el("div", "st-desc", "还没有指令。点「＋ 新增指令」开始。"));
  } else {
    items.forEach((cmd, index) => listCard.append(renderCommand(cmd, index)));
  }
  root.append(listCard);
}

function renderCommand(cmd, index) {
  const box = el("div", "st-cmd");

  // 头部：名称 + 序号 + 删除
  const head = el("div", "st-cmd-head");
  const num = el("span", "st-tag", String(index + 1));
  const nameInput = el("input", "st-input");
  nameInput.value = cmd.name || "";
  nameInput.placeholder = "指令名（显示在这个条目上）";
  nameInput.addEventListener("input", () => {
    cmd.name = nameInput.value;
    dirty = true;
    updateSaveBtn();
  });
  const delBtn = el("button", "st-btn st-btn-danger", "删除");
  delBtn.type = "button";
  delBtn.addEventListener("click", () => {
    items = items.filter((c) => c.id !== cmd.id);
    markDirty();
  });
  head.append(num, nameInput, delBtn);

  // 内容
  const content = el("textarea", "st-textarea");
  content.value = cmd.content || "";
  content.placeholder = "指令内容——发送时被拼进本次用户输入的那段文字（不加任何标记）";
  content.addEventListener("input", () => {
    cmd.content = content.value;
    dirty = true;
    updateSaveBtn();
  });

  // 行：位置 / 快捷键 / 启用
  const grid = el("div", "st-grid");

  const posField = el("label", "st-field");
  posField.append(el("span", null, "拼接位置"));
  const posSel = el("select", "st-select");
  for (const [val, label] of [["head", "头部"], ["tail", "尾部"]]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    posSel.appendChild(o);
  }
  posSel.value = cmd.position === "head" ? "head" : "tail";
  posSel.addEventListener("change", () => {
    cmd.position = posSel.value;
    dirty = true;
    updateSaveBtn();
  });
  posField.append(posSel);

  const keyField = el("label", "st-field");
  keyField.append(el("span", null, "快捷键"));
  const keySel = el("select", "st-select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "无";
  keySel.appendChild(noneOpt);
  for (let i = 1; i <= 9; i++) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = String(i);
    keySel.appendChild(o);
  }
  keySel.value = /^[1-9]$/.test(cmd.shortcut || "") ? cmd.shortcut : "";
  keySel.addEventListener("change", () => {
    cmd.shortcut = keySel.value;
    dirty = true;
    updateSaveBtn();
  });
  keyField.append(keySel);

  const enableField = el("label", "st-switch");
  const enableCb = document.createElement("input");
  enableCb.type = "checkbox";
  enableCb.checked = cmd.enabled !== false;
  enableCb.addEventListener("change", () => {
    cmd.enabled = enableCb.checked;
    dirty = true;
    updateSaveBtn();
  });
  enableField.append(enableCb, el("span", null, "启用"));

  grid.append(posField, keyField, enableField);

  box.append(head, content, grid);
  return box;
}

function updateSaveBtn() {
  const btn = root.querySelector(".st-btn-primary");
  if (btn) {
    btn.disabled = !dirty;
    btn.textContent = dirty ? "保存" : "已保存";
  }
}

// ── 保存 ───────────────────────────────────────────────
async function save() {
  const items_normalized = items
    .filter((c) => (c.name || "").trim())
    .map((c) => ({
      id: c.id,
      name: (c.name || "").trim(),
      content: c.content || "",
      position: c.position === "head" ? "head" : "tail",
      shortcut: /^[1-9]$/.test(c.shortcut || "") ? c.shortcut : "",
      enabled: c.enabled !== false,
    }));
  try {
    const res = await postJson("commands", { agentId: currentAgentId, items: items_normalized });
    items = structuredClone(res.items || []);
    dirty = false;
    inherited = false;
    render();
    toast("已保存");
  } catch (err) {
    toast(`保存失败：${String(err?.message || err)}`);
  }
}

window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ── 启动 ───────────────────────────────────────────────
(async () => {
  // 向宿主发就绪握手（hana.ready）：缺了它，宿主认为没有就绪的 App 视图拥有这个表面，
  // 无论页面本身能不能显示，都会回退到「应用加载失败」占位。
  try {
    await hana.ready();
  } catch (err) {
    clientLog(`hana.ready 失败：${String(err?.message || err)}`);
  }
  try {
    await loadAgentsAndPrefs();
    await loadAgent(DEFAULT_AGENT);
  } catch (err) {
    clientLog(`settings 启动失败: ${String(err?.message || err)}`);
    root.innerHTML = "";
    root.append(el("p", "qc-loading", `加载失败：${String(err?.message || err)}`));
  }
})();
