# Hana快捷指令（quick-cmd）开发日志

## 项目缘起
在 Hana Agent 里，常用命令和提示词每次都要手打或复制粘贴，重复且打断节奏。想要一个能挂在输入栏旁边、点一下就能把预设指令带进本次输入的入口。

## 想要的效果
- 输入栏左下角多一个图标（风格与 Hana 一致，不突兀），点开在输入框上方弹出面板；
- 面板里列出指令名，点选或用数字键 1/2/3 选择；
- 选中的指令在输入框上方以「指令名 ×」的标签形式出现，点 × 取消；
- 发送时，指令内容按各自设置拼到本次用户提示词的头或尾（不加任何标记）；
- 设置里能给每个 agent 单独配置：指令名、指令内容、拼接位置、快捷键；
- 助手也能通过工具增删改指令，且这个能力可在设置里关掉。

## 当前版本
0.1.0

## 外部依赖
无外部进程、无网络、无凭据。纯本地读写应用存储。

## 当前进度
- [x] 项目结构 + 官方 SDK 复制
- [x] 存储层 lib/store.js、拼接层 lib/planner.js
- [x] 服务端 index.js：session/input 钩子、inputStatus 入口工具、CRUD 工具、路由
- [x] 面板 UI（ui/panel.html + assets/panel.js）
- [x] 设置页 UI（ui/settings.html + assets/settings.js）
- [x] 安装 / 启用 / 实机验证
- [x] 官方打包（extension-pack，静态校验通过）
- [x] git 初始化 + 首次提交
- [x] 市场登记 PR（liliMozi/hana-marketplace #88）

## 已知问题 / TODO
- [x] 输入栏 ⌘ 图标已实机确认出现（宿主日志那行 ui-contributions 不单列 inputStatus 计数，以实机为准）。
- [x] 设置页加载、面板选择与取消、发送拼接均实机通过。
- [ ] 平台限制：v2 App **没有**「往输入框内部插 chip」的 API（宿主 inputPanels 只提供「输入框上方」的自有 UI）。因此「指令名标签」落在面板底部的选择条上——它紧贴输入框上沿、左对齐，收起面板时就是输入框上方的一条细带，视觉上等同「输入框左上角」。功能（选中 / × 取消 / 发送拼接）完全按需求实现。
- [ ] 数字键 1-9 需要在面板 iframe 拿到焦点时才生效；打开面板时会尝试 window.focus()，若焦点仍在输入框则按键会进入输入框（更安全的一侧）。
- [ ] 快捷键语义：先按指令各自配置的 `shortcut` 匹配，没有匹配再按列表序号（1 = 第 1 条）。
- [ ] 工具上下文里没有 `sessionId`（只有 sessionPath），已用「钩子现学 + sessions.list + 文件名匹配」三重建映射解决；若某条会话从未发过消息而 sessions.list 也拿不到，面板会打不开。

## 经验记录
### 🐛 踩坑
- 2026-10-13 · **App 页面必须发 `hana.ready()` 握手，否则宿主一律显示「应用加载失败」。** 症状：设置页一打开就「加载失败」，但页面脚本其实跑了（日志里能看到它发出的请求）。原因：缺握手时宿主认为「没有就绪的 App 视图拥有这个表面」，回退到失败占位——跟页面能不能显示无关。修复：页面脚本开头 `import { hana } from "./sdk.js"; await hana.ready();`（参照 hana-preset 的 `main()` 开头）。`ready()` 只是把事件投出去，不阻塞。
- 2026-10-13 · **应用路由的查询串里不能出现 `agentId`。** 宿主持有一个通用中间件，会把 app 路由请求里的 `agentId` 查询参数截走去解析 agent；解析不到该 agent 就让整个请求 404（不是 403，看起来像路由没挂）。症状：设置页一打开就「应用加载失败」，日志里是 `[ui] settings 启动失败: HTTP 404`。因为默认表用了假 agentId `__default__`，`GET /routes/state?agentId=__default__` 必 404。
  验证：`?agentId=<真实 agent id>` 200，`?agentId=__default__`／`?agentId=nope` 404；换成 `?target=__default__` 立刻 200。
  修复：自定义目标 agent 改用 `target` 传参。
- 2026-10-13 · **工具执行的 context 里没有 `sessionId`，只有 `sessionPath`。** 而 `userInteraction.show({sessionId})` 必须要 sessionId。修复：三重建映射——钩子里现学（钩子两边都给）、`sessions.list` 建 path→id 映射、按文件名兜底。
- 2026-10-13 · 平台无「composer chip」注入 API。查遍 v2 App SDK（context.d.ts / ui-contribution-points / 桌面包字符串）确认：应用能拿到的输入框相关座位只有 `hana/input.controls`（按钮）、`hana/input.attention`（横幅）、inputPanels（上方 UI）；能改写用户输入的唯一入口是 `hooks.onDecision("session/input")`。据此定架构：面板管「选」，钩子管「拼」。

### ✅ 成功经验
- 2026-10-13 · 本机 `github.com:443` 被拦、`git push` 不通，改用 **Git Data API** 逐个写 blob（361 个文件）建仓库：先用 Contents API 造一个初始提交把空仓库激活（空仓库写 blob 会 409），再建全量 tree、用一个**根提交**（无 parent）承载全部文件，最后 `PATCH` ref 强制指过去——历史只留一个干净提交。`uploads.github.com` 通（Release 附件走它）。
- 2026-10-13 · 市场收录要的是「作者仓库的正式 Release」：先把包用 `extension-pack` 打好，把 `archive.sha256` 照抄进 `approvals.json`；PR 只改 `registry.json` + `approvals.json` 两份。开完 PR 后从 Release 重新下载 zip 复算 sha256，与登记值对得上才算过。
- 2026-10-13 · 用「待消费选择」把面板与钩子解耦：面板 POST /select 写一份按 sessionId 索引的 id 列表，钩子读到后用一次即清。既满足「只作用于本次输入」，又不需要面板与发送动作直接握手。
- 2026-10-13 · 复用 prompt-studio / hana-preset 的官方 SDK 与页面引导（theme-boot / app-api），少踩 SDK 通信与鉴权的坑。

## 功能验证清单
### 后端工具
- [x] `quickcmd_open` - 打开输入框上方面板 - 输入：{} / 结果：成功打开
- [x] `quickcmd_list` - 列指令 - 输入：{} / 结果：正确解析当前 agent 并回读指令表
- [ ] `quickcmd_upsert` - 写指令 - 输入：{agentId,name,content,position}
- [ ] `quickcmd_delete` - 删指令 - 输入：{agentId,id}
- [x] 路由 `GET /state` - 输入：?sessionId= / ?target=（注意不能用 agentId）
- [x] 路由 `POST /select|/clear|/commands|/prefs|/dismiss-panel`

### 前端 UI
- [x] 输入栏出现 ⌘ 图标，点击在输入框上方弹出面板 - 人眼确认
- [x] 面板里点指令 / 按数字键选择，底部出现「指令名 ×」 - 手动确认
- [x] 发送后指令内容拼到本次输入头/尾，标签随发送清空 - 手动确认
- [x] 设置页：选 agent、增删改指令、保存、恢复继承默认 - 手动确认
- [ ] 设置页：关掉 Agent 工具后，quickcmd_* 三件套撤下

## 发布记录
- 仓库：https://github.com/Magnemomet/hana-quick-cmd（公开）
- 首个提交：`1a8d35f`（361 个文件）
- Release：`v0.1.0`，附件 `app-quick-cmd-0.1.0.zip`（2,413,643 字节，sha256 `9083e69b…ccfa6c0`）与 `app-quick-cmd-0.1.0.entry.json`
- 市场登记 PR：`liliMozi/hana-marketplace` #88（registry.json +1 条、approvals.json +1 条）
- 核验：从 Release 重新下载 zip 复算 sha256，与登记值一致
- 待补：PR 正文里的界面截图（作者补），以及同意后重跑市场同步器

## 备份记录
（自动维护）

## 审查记录
（暂无）
