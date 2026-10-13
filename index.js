// quick-cmd — Hana快捷指令 · 服务端入口
//
// 做一件事：让用户在输入栏点一个图标，挑几条预设指令，发送时把指令内容
// 拼到本次用户提示词的头或尾。
//
// 四条职责线：
//   ① 输入栏图标（manifest 里声明的 inputStatus），点击走 quickcmd_open 工具；
//   ② 输入框上方的面板（userInteraction.show + app/input.panels），面板里选指令；
//   ③ session/input 钩子：发送前把选中的指令拼进本次输入——这是"拼接"真正发生的地方；
//   ④ 三个 Agent 工具（list/upsert/delete）增删改指令，可在设置里整体关闭。
//
// 面板与钩子之间的桥是一份"待消费选择"：面板 POST /select 写进去，
// 钩子读到后用一次即清。键用 sessionId，两边都拿得到。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "./sdk/app-contract/server-client.js";
import {
  DEFAULT_AGENT,
  POSITIONS,
  POSITION_LABEL,
  readAllCommands,
  effectiveCommands,
  saveAgentCommands,
  deleteAgentCommands,
  readPrefs,
  writePrefs,
  readPendingFor,
  writePendingFor,
  clearPendingFor,
  normalizeCommandList,
  newId,
} from "./lib/store.js";
import { pickCommands, composeInput } from "./lib/planner.js";

export const name = "quick-cmd";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PANEL_ID = "quickcmd-panel";
const STATUS_ID = "open";
const BASE_STATUS_TEXT = "⌘";

function readVersion() {
  try {
    const v = JSON.parse(readFileSync(join(APP_DIR, "manifest.json"), "utf8")).version;
    return typeof v === "string" && v.trim() ? v.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 从会话文件路径推 agentId：会话都在 <home>/agents/<agentId>/... 下。 */
function agentIdFromPath(p) {
  if (typeof p !== "string" || p.length === 0) return null;
  const m = /(?:^|[\\/])agents[\\/]([^\\/]+)[\\/]/.exec(p);
  return m && m[1] ? m[1] : null;
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("quick-cmd loaded");

  // sessionId / sessionPath -> agentId 的会话内缓存
  const agentIdBySession = new Map();

  // sessionPath -> sessionId。工具上下文只给 sessionPath，但打开面板要的是 sessionId；
  // 映射在钩子里现学（钩子两边都给），另用 sessions.list 兜底。
  const pathToSessionId = new Map();
  const baseToSessionId = new Map();
  const basenameOf = (p) => String(p || "").replace(/\\/g, "/").split("/").pop();

  function rememberSession(sessionPath, sessionId) {
    if (!sessionPath || !sessionId) return;
    pathToSessionId.set(sessionPath, sessionId);
    const b = basenameOf(sessionPath);
    if (b) baseToSessionId.set(b, sessionId);
  }

  async function resolveSessionId(explicitId, sessionPath) {
    if (explicitId) return explicitId;
    if (!sessionPath) return null;
    if (pathToSessionId.has(sessionPath)) return pathToSessionId.get(sessionPath);

    try {
      const res = await sdk.sessions.list({ scope: "all", lifecycle: "all" });
      const list = Array.isArray(res?.sessions) ? res.sessions : [];
      for (const s of list) {
        if (!s?.sessionId) continue;
        if (s.path) rememberSession(s.path, s.sessionId);
        if (s.sessionPath) rememberSession(s.sessionPath, s.sessionId);
      }
    } catch (err) {
      await sdk.logger.warn(`sessions.list 失败：${String(err?.message || err)}`);
    }
    if (pathToSessionId.has(sessionPath)) return pathToSessionId.get(sessionPath);
    const b = basenameOf(sessionPath);
    if (b && baseToSessionId.has(b)) return baseToSessionId.get(b);

    try {
      const res = await sdk.sessions.get({ sessionPath, scope: "all" });
      const id = res?.session?.sessionId || null;
      if (id) rememberSession(sessionPath, id);
      return id;
    } catch (err) {
      await sdk.logger.warn(`sessions.get(sessionPath) 失败：${String(err?.message || err)}`);
      return null;
    }
  }

  /**
   * 解析一段会话属于哪个 agent。
   * ① 会话路径直接推（最稳，不依赖 bus）；② sessions.list 建映射；③ sessions.get。
   */
  async function resolveAgentId(session) {
    const sessionPath = session?.sessionPath || null;
    const sessionId = session?.sessionId || null;
    const key = sessionPath || sessionId;
    if (!key) return null;
    if (agentIdBySession.has(key)) return agentIdBySession.get(key);

    const fromPath = agentIdFromPath(sessionPath);
    if (fromPath) {
      agentIdBySession.set(key, fromPath);
      return fromPath;
    }

    try {
      const res = await sdk.sessions.list({ scope: "all", lifecycle: "all" });
      const list = Array.isArray(res?.sessions) ? res.sessions : [];
      for (const s of list) {
        if (!s?.agentId) continue;
        if (s.sessionId) agentIdBySession.set(s.sessionId, s.agentId);
        if (s.path) agentIdBySession.set(s.path, s.agentId);
      }
      if (agentIdBySession.has(key)) return agentIdBySession.get(key);
    } catch (err) {
      await sdk.logger.warn(`sessions.list 失败：${String(err?.message || err)}`);
    }

    try {
      const req = sessionPath ? { sessionPath, scope: "all" } : { sessionId, scope: "all" };
      const res = await sdk.sessions.get(req);
      const id = res?.session?.agentId || null;
      if (id) {
        agentIdBySession.set(key, id);
        return id;
      }
    } catch (err) {
      await sdk.logger.warn(`sessions.get 失败：${String(err?.message || err)}`);
    }
    return null;
  }

  /** 把输入栏那个图标的文字同步成「⌘N」，让收起面板时也能看出选了几条。 */
  async function setStatus(sessionId, count) {
    if (!sessionId) return;
    try {
      await sdk.inputStatus.set({
        sessionId,
        id: STATUS_ID,
        text: count > 0 ? `${BASE_STATUS_TEXT}${count}` : BASE_STATUS_TEXT,
      });
    } catch (err) {
      // 图标文字同步失败不影响功能，静默
    }
  }

  // ── 面板 ────────────────────────────────────────────────────────────────
  async function showPanel(sessionId) {
    if (!sessionId) return false;
    try {
      await sdk.userInteraction.show({
        sessionId,
        id: PANEL_ID,
        title: "快捷指令",
        contentFrame: { route: "/panel.html" },
        presentation: { height: 300, collapsedHeight: 36, expanded: true },
      });
      return true;
    } catch (err) {
      await sdk.logger.warn(
        `面板打开失败：${String(err?.code || err?.name || "error")} ${String(err?.message || err)}`,
      );
      return false;
    }
  }

  async function dismissPanel(sessionId) {
    if (!sessionId) return false;
    try {
      await sdk.userInteraction.dismiss({ sessionId, id: PANEL_ID });
      return true;
    } catch {
      return false;
    }
  }

  // ── 工具：始终注册的入口工具 ──────────────────────────────────────────────
  await sdk.tools.register({
    name: "quickcmd_open",
    description: "在对话输入框上方打开「快捷指令」面板，让用户挑选要拼进本次输入的指令。",
    parameters: { type: "object", properties: {} },
    execute: async (args) => {
      const ctx = args?.context || {};
      const sessionId = await resolveSessionId(ctx.sessionId || null, ctx.sessionPath || null);
      if (!sessionId) {
        await sdk.logger.warn(
          `quickcmd_open 拿不到 sessionId，context=${JSON.stringify(Object.keys(ctx))} sessionPath=${JSON.stringify(ctx.sessionPath || null)}`,
        );
        return { content: [{ type: "text", text: "没能打开面板：当前会话拿不到稳定 sessionId。" }], isError: true };
      }
      const ok = await showPanel(sessionId);
      return {
        content: [{ type: "text", text: ok ? "快捷指令面板已打开在输入框上方。" : "面板打开失败。" }],
        isError: !ok,
      };
    },
  });

  // ── 工具：Agent 增删改（可在设置里整体关闭） ──────────────────────────────
  /** 目标 agent：显式传的优先；否则从工具调用上下文里的会话推。 */
  async function targetAgentId(args) {
    const explicit = typeof args?.agentId === "string" ? args.agentId.trim() : "";
    if (explicit) return explicit;
    const ctx = args?.context || {};
    const fromPath = agentIdFromPath(ctx.sessionPath);
    if (fromPath) return fromPath;
    return resolveAgentId({ sessionPath: ctx.sessionPath || null, sessionId: ctx.sessionId || null });
  }

  async function registerCrudTools() {
    const disposers = [];
    disposers.push(
      await sdk.tools.register({
        name: "quickcmd_list",
        description:
          "列出某个 agent 的快捷指令（名称、内容、拼接位置、快捷键、是否启用）。" +
          "不传 agentId 时，用当前对话所属的 agent；返回里会标注该 agent 是否在用兜底默认表。",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "目标 agent id；省略则用当前会话的 agent" },
          },
        },
        execute: async (args) => {
          const agentId = await targetAgentId(args);
          const all = await readAllCommands(sdk);
          const own = agentId && Array.isArray(all[agentId]);
          const list = effectiveCommands(all, agentId);
          const lines = list.map((c, i) => {
            const pos = POSITION_LABEL[c.position] || c.position;
            const key = c.shortcut ? ` · 快捷键 ${c.shortcut}` : "";
            const off = c.enabled === false ? " · 已停用" : "";
            return `${i + 1}. ${c.name}（${pos}${key}${off}）\n   ${c.content || ""}`;
          });
          const header = `agent=${agentId || "未知"}${own ? "" : "（继承兜底默认表）"}，共 ${list.length} 条：`;
          return {
            content: [{ type: "text", text: list.length ? `${header}\n${lines.join("\n")}` : `${header}\n（空）` }],
            details: { quickcmd: { agentId, own, commands: list } },
          };
        },
      }),
    );

    disposers.push(
      await sdk.tools.register({
        name: "quickcmd_upsert",
        description:
          "新增或修改一条快捷指令。给 id 就是改那条；不给 id 按 name 找，找到就改、找不到就新建。" +
          "position 决定发送时拼到本次输入的头（head）还是尾（tail），默认尾。",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "目标 agent id；省略则用当前会话的 agent" },
            id: { type: "string", description: "要修改的指令 id，省略则按 name 匹配或新建" },
            name: { type: "string", description: "指令名（显示名，也是按名匹配的键）" },
            content: { type: "string", description: "指令内容——发送时被拼进用户输入的那段文字" },
            position: { type: "string", enum: POSITIONS, description: "拼接位置：head 头部 / tail 尾部" },
            shortcut: { type: "string", description: "数字快捷键 1-9，留空表示不设" },
            enabled: { type: "boolean", description: "是否启用，默认 true" },
          },
          required: ["name"],
        },
        execute: async (args) => {
          const agentId = await targetAgentId(args);
          if (!agentId) return { content: [{ type: "text", text: "无法确定目标 agent。" }], isError: true };
          const all = await readAllCommands(sdk);
          const list = Array.isArray(all[agentId]) ? all[agentId].slice() : [];
          const name = String(args?.name || "").trim();
          if (!name) return { content: [{ type: "text", text: "缺少指令名 name。" }], isError: true };

          let idx = -1;
          if (typeof args?.id === "string" && args.id.trim()) {
            idx = list.findIndex((c) => c.id === args.id.trim());
          }
          if (idx < 0) idx = list.findIndex((c) => c.name === name);

          const base = idx >= 0 ? list[idx] : { id: newId(), name, content: "", position: "tail", shortcut: "", enabled: true };
          const next = {
            ...base,
            name,
            content: typeof args?.content === "string" ? args.content : base.content,
            position: args?.position === undefined ? base.position : args.position,
            shortcut: args?.shortcut === undefined ? base.shortcut : args.shortcut,
            enabled: args?.enabled === undefined ? base.enabled : args.enabled !== false,
          };
          if (idx >= 0) list[idx] = next;
          else list.push(next);

          const saved = await saveAgentCommands(sdk, agentId, list);
          const found = saved.find((c) => c.id === next.id) || next;
          return {
            content: [
              {
                type: "text",
                text: `${idx >= 0 ? "已更新" : "已新增"}指令「${found.name}」（${POSITION_LABEL[found.position] || found.position}），agent=${agentId}。`,
              },
            ],
            details: { quickcmd: { agentId, command: found } },
          };
        },
      }),
    );

    disposers.push(
      await sdk.tools.register({
        name: "quickcmd_delete",
        description: "删除一条快捷指令。按 id 或 name 定位。",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "目标 agent id；省略则用当前会话的 agent" },
            id: { type: "string", description: "要删除的指令 id" },
            name: { type: "string", description: "要删除的指令名（与 id 二选一）" },
          },
        },
        execute: async (args) => {
          const agentId = await targetAgentId(args);
          if (!agentId) return { content: [{ type: "text", text: "无法确定目标 agent。" }], isError: true };
          const all = await readAllCommands(sdk);
          const list = Array.isArray(all[agentId]) ? all[agentId].slice() : [];
          const id = typeof args?.id === "string" ? args.id.trim() : "";
          const name = typeof args?.name === "string" ? args.name.trim() : "";
          const before = list.length;
          const kept = list.filter((c) => !(id && c.id === id) && !(name && c.name === name));
          if (kept.length === before) {
            return { content: [{ type: "text", text: "没找到要删除的指令。" }], isError: true };
          }
          await saveAgentCommands(sdk, agentId, kept);
          return {
            content: [{ type: "text", text: `已删除 ${before - kept.length} 条指令，agent=${agentId}。` }],
            details: { quickcmd: { agentId, removed: before - kept.length } },
          };
        },
      }),
    );

    return disposers;
  }

  let crudDisposers = [];
  async function syncCrudTools() {
    for (const d of crudDisposers) {
      try {
        await d?.disposeAsync?.();
      } catch {
        /* 已经拆掉的忽略 */
      }
    }
    crudDisposers = [];
    const prefs = await readPrefs(sdk);
    if (!prefs.agentToolsEnabled) return;
    try {
      crudDisposers = await registerCrudTools();
    } catch (err) {
      await sdk.logger.error(`注册 Agent 工具失败：${String(err?.message || err)}`);
    }
  }

  await syncCrudTools();

  // ── 钩子：发送前把选中的指令拼进本次输入 ──────────────────────────────────
  // 这是「拼接」唯一的落点。读到待消费选择就用掉并清空，保证一条指令只生效一次。
  await sdk.hooks.onDecision("session/input", async (inv) => {
    const sessionId = inv?.session?.sessionId || null;
    if (!sessionId) return undefined;
    // 顺手学下 sessionPath -> sessionId，供打开面板的工具用
    rememberSession(inv?.session?.sessionPath || null, sessionId);

    const ids = await readPendingFor(sdk, sessionId);
    if (!ids.length) return undefined;

    // 消费：先清，再算，避免钩子因任何原因重入时重复拼接
    await clearPendingFor(sdk, sessionId);
    await setStatus(sessionId, 0);

    const agentId = await resolveAgentId(inv.session);
    const all = await readAllCommands(sdk);
    const commands = effectiveCommands(all, agentId);
    const chosen = pickCommands(commands, ids);
    if (!chosen.length) return undefined;

    const next = composeInput(inv.text || "", chosen);
    if (next === (inv.text || "")) return undefined;

    await sdk.logger.info(
      `已拼接（agent=${agentId || "?"}）：${chosen.map((c) => c.name).join("、")} | ${(inv.text || "").length}→${next.length}`,
    );
    return { text: next };
  });

  // ── 应用自己的路由 ────────────────────────────────────────────────────────
  await sdk.routes.register((app) => {
    app.get("/meta", async (c) => {
      return c.json({ ok: true, version: readVersion(), positions: POSITIONS, positionLabels: POSITION_LABEL });
    });

    // 面板 / 设置页共用的状态
    app.get("/state", async (c) => {
      const sessionId = c.req.query("sessionId") || "";
      let agents = [];
      try {
        const res = await sdk.agents.list({ scope: "all", lifecycle: "active" });
        agents = (res?.agents || []).map((a) => ({ id: a.id, name: a.name, yuan: a.yuan || null }));
      } catch (err) {
        await sdk.logger.warn(`agents.list 失败：${String(err?.message || err)}`);
      }
      // 注意：查询参数不能叫 agentId —— 宿主会截走这个参数名去解析 agent，
      // 认不出就整个请求 404。所以自定义的目标 agent 用 target 传。
      const qAgent = c.req.query("target") || "";
      const agentId = qAgent || (sessionId ? await resolveAgentId({ sessionId }) : null);
      const all = await readAllCommands(sdk);
      const prefs = await readPrefs(sdk);
      const hasOwn = !!(agentId && Array.isArray(all[agentId]));
      return c.json({
        ok: true,
        version: readVersion(),
        agents,
        agentId,
        hasOwn,
        commands: effectiveCommands(all, agentId),
        defaultCommands: Array.isArray(all[DEFAULT_AGENT]) ? all[DEFAULT_AGENT] : [],
        ownCommands: agentId && Array.isArray(all[agentId]) ? all[agentId] : null,
        pending: sessionId ? await readPendingFor(sdk, sessionId) : [],
        prefs,
        positions: POSITIONS,
        positionLabels: POSITION_LABEL,
      });
    });

    // 面板里选/取消一条指令
    app.post("/select", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      const commandId = typeof body?.commandId === "string" ? body.commandId : "";
      const action = ["toggle", "add", "remove"].includes(body?.action) ? body.action : "toggle";
      if (!sessionId || !commandId) return c.json({ ok: false, error: "BAD_INPUT" }, 400);

      let ids = await readPendingFor(sdk, sessionId);
      const has = ids.includes(commandId);
      if (action === "add" || (action === "toggle" && !has)) {
        if (!has) ids = [...ids, commandId];
      } else if (action === "remove" || (action === "toggle" && has)) {
        ids = ids.filter((x) => x !== commandId);
      }
      await writePendingFor(sdk, sessionId, ids);
      await setStatus(sessionId, ids.length);
      return c.json({ ok: true, pending: ids });
    });

    app.post("/clear", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) return c.json({ ok: false, error: "NO_SESSION" }, 400);
      await clearPendingFor(sdk, sessionId);
      await setStatus(sessionId, 0);
      return c.json({ ok: true, pending: [] });
    });

    app.post("/dismiss-panel", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) return c.json({ ok: false, error: "NO_SESSION" }, 400);
      const ok = await dismissPanel(sessionId);
      return c.json({ ok });
    });

    // 设置页：保存某个 agent 的整张指令表
    app.post("/commands", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const agentId = typeof body?.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : DEFAULT_AGENT;
      const saved = await saveAgentCommands(sdk, agentId, body?.items);
      return c.json({ ok: true, agentId, items: saved });
    });

    // 设置页：让某个 agent 回到「继承兜底」
    app.post("/agent/reset", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const agentId = typeof body?.agentId === "string" ? body.agentId.trim() : "";
      if (!agentId || agentId === DEFAULT_AGENT) return c.json({ ok: false, error: "BAD_INPUT" }, 400);
      await deleteAgentCommands(sdk, agentId);
      return c.json({ ok: true });
    });

    // 设置页：偏好（含 Agent 工具开关，改完立即生效）
    app.post("/prefs", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const current = await readPrefs(sdk);
      const next = await writePrefs(sdk, {
        agentToolsEnabled: body?.agentToolsEnabled === undefined ? current.agentToolsEnabled : body.agentToolsEnabled === true,
        defaultPosition: body?.defaultPosition === undefined ? current.defaultPosition : body.defaultPosition,
      });
      await syncCrudTools();
      return c.json({ ok: true, prefs: next });
    });

    // iframe 里的 console 外面看不到，借后端写进 Hana 日志
    app.post("/client-log", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const message = typeof body?.message === "string" ? body.message.slice(0, 400) : "";
      if (message) await sdk.logger.info(`[ui] ${message}`);
      return c.json({ ok: true });
    });
  });
});
