// lib/planner.js — 把选中的指令合并进本次用户输入
//
// 规则就一条：不改变用户原文，只在头/尾接上指令内容。
// 拼接位置来自每条指令自己的 position；多条同位置按选择顺序排。
// 不用任何标记（不加「【指令】」之类），因为需求就是「无需特别标识」。
// 原文为空时（只发指令），结果就是指令内容本身。

const SEP = "\n\n";

/** 从待选里挑出这次真正生效的指令：id 命中、且 enabled。 */
export function pickCommands(commands, ids) {
  const byId = new Map((commands || []).map((c) => [c.id, c]));
  const out = [];
  for (const id of ids || []) {
    const cmd = byId.get(id);
    if (cmd && cmd.enabled !== false && (cmd.content || "").length > 0) out.push(cmd);
  }
  return out;
}

/** 拼出最终文本。head 部分在前、tail 部分在后，原文夹中间。 */
export function composeInput(text, commands) {
  const head = [];
  const tail = [];
  for (const cmd of commands || []) {
    const body = String(cmd.content || "").trim();
    if (!body) continue;
    if (cmd.position === "head") head.push(body);
    else tail.push(body);
  }
  const original = typeof text === "string" ? text : "";
  const parts = [];
  if (head.length) parts.push(head.join(SEP));
  if (original.length) parts.push(original);
  if (tail.length) parts.push(tail.join(SEP));
  return parts.join(SEP);
}
