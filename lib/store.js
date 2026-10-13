// lib/store.js — 快捷指令的存储层
//
// 三份数据都在应用全局存储里，按 key 分区：
//   commands.v1  { agents: { [agentId]: Command[] } }
//                agent 自己的指令表；agentId = "__default__" 是兜底表，
//                没有单独配置的 agent 继承它。
//   prefs.v1     { agentToolsEnabled: boolean, defaultPosition: "head" | "tail" }
//   pending.v1   { [sessionId]: { ids: string[], at: number } }
//                面板里选中、等本次发送消费掉的指令 id 列表。消费一次即清。

export const KEY_COMMANDS = "commands.v1";
export const KEY_PREFS = "prefs.v1";
export const KEY_PENDING = "pending.v1";

/** 兜底 agent 槽位：名字不可能是真实 agentId，用双下划线包住。 */
export const DEFAULT_AGENT = "__default__";

export const POSITIONS = ["head", "tail"];
export const POSITION_LABEL = { head: "头部", tail: "尾部" };

/** 面板里最多支持到 9 个数字快捷键。 */
export const MAX_SHORTCUT = 9;

const MAX_NAME = 40;
const MAX_CONTENT = 8000;
const PENDING_TTL_MS = 30 * 60 * 1000;

export function normalizePosition(v) {
  return POSITIONS.includes(v) ? v : "tail";
}

/** 把一条指令规整成稳定形状；返回 null 表示这条无效、应丢掉。 */
export function normalizeCommand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, MAX_NAME) : "";
  const content = typeof raw.content === "string" ? raw.content.slice(0, MAX_CONTENT) : "";
  if (!name) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : newId();
  let shortcut = typeof raw.shortcut === "string" ? raw.shortcut.trim() : "";
  if (!/^[1-9]$/.test(shortcut)) shortcut = "";
  return {
    id,
    name,
    content,
    position: normalizePosition(raw.position),
    shortcut,
    enabled: raw.enabled !== false,
  };
}

export function newId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** 规整一整张指令表：逐条过滤 + 快捷键去重（先到先得）。 */
export function normalizeCommandList(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const usedShortcut = new Set();
  for (const item of list) {
    const cmd = normalizeCommand(item);
    if (!cmd) continue;
    if (cmd.shortcut && usedShortcut.has(cmd.shortcut)) cmd.shortcut = "";
    if (cmd.shortcut) usedShortcut.add(cmd.shortcut);
    out.push(cmd);
  }
  return out;
}

async function read(sdk, key, fallback) {
  try {
    const v = await sdk.storage.global.get(key, fallback);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

async function write(sdk, key, value) {
  try {
    await sdk.storage.global.set(key, value);
    return true;
  } catch {
    return false;
  }
}

// ── 指令表 ────────────────────────────────────────────────────────────────

export async function readAllCommands(sdk) {
  const raw = await read(sdk, KEY_COMMANDS, { agents: {} });
  const agents = raw && typeof raw.agents === "object" && raw.agents ? raw.agents : {};
  const out = {};
  for (const [agentId, list] of Object.entries(agents)) {
    out[agentId] = normalizeCommandList(list);
  }
  return out;
}

/** 取某个 agent 生效的指令表：自己有配置就用自己那份，否则继承兜底。 */
export function effectiveCommands(all, agentId) {
  if (agentId && Array.isArray(all[agentId])) return all[agentId];
  return Array.isArray(all[DEFAULT_AGENT]) ? all[DEFAULT_AGENT] : [];
}

export async function saveAgentCommands(sdk, agentId, items) {
  const all = await readAllCommands(sdk);
  all[agentId] = normalizeCommandList(items);
  await write(sdk, KEY_COMMANDS, { agents: all });
  return all[agentId];
}

/** 删掉某个 agent 自己的配置，让它重新继承兜底默认表。 */
export async function deleteAgentCommands(sdk, agentId) {
  const all = await readAllCommands(sdk);
  delete all[agentId];
  await write(sdk, KEY_COMMANDS, { agents: all });
  return true;
}

// ── 偏好 ──────────────────────────────────────────────────────────────────

export async function readPrefs(sdk) {
  const raw = await read(sdk, KEY_PREFS, null);
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    agentToolsEnabled: obj.agentToolsEnabled !== false,
    defaultPosition: normalizePosition(obj.defaultPosition),
  };
}

export async function writePrefs(sdk, prefs) {
  const next = {
    agentToolsEnabled: prefs.agentToolsEnabled !== false,
    defaultPosition: normalizePosition(prefs.defaultPosition),
  };
  await write(sdk, KEY_PREFS, next);
  return next;
}

// ── 待消费的选择 ──────────────────────────────────────────────────────────

export async function readPending(sdk) {
  const raw = await read(sdk, KEY_PENDING, {});
  const obj = raw && typeof raw === "object" ? raw : {};
  const now = Date.now();
  let dirty = false;
  for (const [key, entry] of Object.entries(obj)) {
    if (!entry || !Array.isArray(entry.ids) || now - (entry.at || 0) > PENDING_TTL_MS) {
      delete obj[key];
      dirty = true;
    }
  }
  if (dirty) await write(sdk, KEY_PENDING, obj);
  return obj;
}

export async function readPendingFor(sdk, sessionId) {
  if (!sessionId) return [];
  const all = await readPending(sdk);
  const entry = all[sessionId];
  return entry && Array.isArray(entry.ids) ? entry.ids : [];
}

export async function writePendingFor(sdk, sessionId, ids) {
  const all = await readPending(sdk);
  if (!ids || ids.length === 0) delete all[sessionId];
  else all[sessionId] = { ids, at: Date.now() };
  await write(sdk, KEY_PENDING, all);
  return ids || [];
}

export async function clearPendingFor(sdk, sessionId) {
  return writePendingFor(sdk, sessionId, []);
}
