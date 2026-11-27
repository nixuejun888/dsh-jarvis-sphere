# dsh-jarvis-sphere

贾维斯式的全息神经元球，长在 DeepSeek Harness Web 界面的整帧浮层里，**由当前任务的真实执行数据驱动**：Agent 有没有在跑、模型流式输出多快、刚刚调用了哪个工具。整层穿透点击，不影响任何操作。

![preview](docs/preview.png)

## 一眼看懂

- **待机**：球慢慢自转，暗青色，偶尔划过一道数据弧；记忆点按自己的节奏呼吸。
- **思考 / 输出**：转速和亮度跟上模型流式速率，节点脉冲变密，底部环形表跟着涨。
- **调工具**：每一次工具调用炸出一圈琥珀色冲击波，同时亮起越球数据弧和火花。
- **写记忆**：新增一条记忆时，球上会亮起一颗新光点并划一道弧。
- **球心是空的**：聊天正文落在球心的暗区，光效不压字。

## 记忆光点与人格

**记忆即光点。** Host 半边读本机 Mnemon 的存储根（`runtime/memories.json`、
`data/.dsh-memory-bodies.json`、`documents/index.json`），把每条记忆按内容哈希钉到球面槽位上：
同一条记忆永远落在同一处，颜色分四类——

| 光点 | 来源 | 颜色 |
| --- | --- | --- |
| 用户画像 | USER.md 条目 | 琥珀 |
| 工作记忆 | MEMORY.md 条目 | 冷白青 |
| 记忆空间 | 已注册的记忆空间 | 紫 |
| 混合槽位 | 多条不同类型挤在同一槽 | 琥珀×青 |

大小和亮度跟重要度（critical / normal / low）与新鲜度走：旧记忆会变暗但不会熄灭，24 小时内写过的会呼吸。

**没有条数上限。** 槽位数固定（默认跟随 `nodeCount`，上限 1400），多条记忆撞进同一槽时合并成**一颗更亮更大的光点**
（亮度按 `log(1+条数)` 放大），HUD 的人数永远是真实总数。实测 5,000 条记忆 + 300 篇文档：
槽位 460、快照 22 KB，一条都不丢、不截断。
文档不走球面槽位，改成外圈 **96 格刻度环**：归档越多，环上刻度越密越亮，永远不跟工作记忆抢位置。

**正文永不下发。** 快照里只有 `{槽位, 类型, 条数, 重要度, 年龄, 新鲜}` 与 96 个文档计数，
没有条目正文、没有文档标题。

**存储根发现。** 顺序：`memoryDirs` 显式配置 → `dsh-mnemon` 的 synced config `dataDir` → 本机 profile 补丁里
`mnemon` 行的 `dataDir`（支持自定义盘符）→ `~/.mnemon`；多个候选都存在时**取 `memories.json` 最新写入的那个**，
不会被过期备份里的旧库存冒充。

**永久人格。** Host 半边同时往系统提示里注册一个全局 section（`jarvis:persona`，order 100，
紧跟在 `deployment:persona-prefix` 之后），所以每一个会话——包括子代理和新建会话——都带着同一套
JARVIS 语气与工作习惯，而不是只在这个会话里临时生效。它是提示文本，末尾明确写着：
即时指令、准确性、安全与工具规则一律高于人设。

- 关掉人格：行配置 `persona: false`；换掉正文：`personaText: "..."`。
- 槽位数：`memorySlots`（0 = 跟随 `nodeCount`）；记忆根：`memoryDirs: [...]`。

## 记忆管家：只读审计工具

光点让你**看见**记忆，`jarvis_memory_review` 让你**打理**记忆。它是 JARVIS 自己的工具（Host 注册，模型可直接调用），
扫本机 Mnemon 存储根后只回报建议，不改任何一条：

| 检查项 | 说明 |
| --- | --- |
| 容量 | MEMORY.md / USER.md 的字节数与占用比（按 dsh-mnemon 的真实上限，默认 10 KB / 4 KB），85% 以上先提示合并 |
| 完全重复 | 去掉空白、大小写、标点后文本相同的条目组 |
| 近重复 | `max(Jaccard, 包含度)` ≥ 0.62 的条目组，附相似度与摘要；这条阈值是拿真实记忆库标定的（被重述过的规则约 0.81，不相关条目都在 0.40 以下） |
| 陈旧可归档 | 超过 120 天且非 critical 的条目 |
| 过长 | 超过 900 字的条目，建议拆成「规则 + 详情」两条 |

**边界写死在工具里**：合并、删除、归档一概不做。它给的是候选清单，动手要你点头。

```bash
node test/keeper-smoke.mjs  # 25/25
```

## 人格文件与版本

人设不再写死在代码里，而是包内的 `persona.md`（跟着仓库走版本）：

- 优先级：行配置 `personaText` → `personaFile` 指定的文件 → 包内 `persona.md` → 一行兜底（**显式文件坏了会回落到包内文件**，只有两个都拿不到才用兜底，并打一条 warn）；`persona.md` 按 LF 归一化后哈希，仓库里有 `.gitattributes` 锁行尾，换机器版本号不变；
- 快照里的 `persona` 会带 `source`（config / file / fallback）与 `version`（正文哈希前 8 位），一眼看出当前跑的是哪一版；
- 改人格 = 改 `persona.md`，重启插件即生效；想临时试一版就填 `personaText`，不污染仓库；
- 每周自检除了记忆库，也会复盘「这周有几处偏离人格」，偏离了就改文件、升版本。
## 仪表：记忆 / 上下文 / 待办 / 错误

仪表默认**不向球外发光**，避免和叠在球上的正文抢对比度：**记忆填充**只体现为球面星尘的亮度（0.66×→1.06×），**上下文压力**与**记忆容量**平时不额外画东西；任一读数越过 85% 才会出现一道贴边细环（琥珀=记忆、红=上下文，带呼吸），告警解除即消失。想回到旧弧线可设 `gauge: 'arc'`。球体不只会动，它报健康。HUD 首行是
`JARVIS · 运行中 · 15 记忆 80% · 上下文 48% · 今日 23 · 2 任务 · 6 工具`，告警（`!N 错误`、`自检`、`N 提醒`）排在最前。

| 通道 | 数据源 | 渲染 |
| --- | --- | --- |
| 记忆容量 | `MEMORY.md 已用 / dsh-mnemon 真实上限`（一次 stat，5 秒缓存） | **星尘亮度**（0.66×→1.06×）；≥85% 才出现贴边琥珀细环并染色 HUD |
| 上下文压力 | `tokenMeter.contextPressure(session)`，取**最忙会话**的占用率（2 秒缓存） | 平时不画；≥85% 出现贴边红色细环；比例 clamp 到 1 |
| 待办 | `schedule.list({active:true})`（30 秒缓存，带 10 秒 inflight 超时） | `N TASKS`；没工具在跑时第二行显示 `NEXT <多久后>` |
| 近期错误 | `agent/error` 时间戳（15 分钟窗口，4096 上限） | `!N ERR` 并把整行染成告警色（主题相关） |

实现约束（都是被复查打回来过的地方）：

- 两条压力弧画在球体**上方**，不压底部文字；半径按 `R*1.045 / R*1.07` 取比例，窗口再小也不重叠；
- HUD 按优先级拼装（错误 → 记忆 → 上下文 → 今日 → 任务 → 工具），宽度预算按**显示格数**算（中文算 2 格），超出就丢末尾，不出现 `...`；
- 快照只带 Client 真正读的 9 个 cfg 键，`personaText` 之类的配置不上线；
- 错误窗口一次扫描 + 一次 `splice` 剪枝，并在写入处就压到 4096，页面关久了重开也不会卡住 Host；
- 事件窗口（流式帧 / 工具调用 / 错误）都有 4096 硬上限；
- 任何服务缺失或抛错都只让对应通道降级为 0，绝不让 `apply` 抛错。

## 编年史：今天第几件事

每个回合结束写一行 JSON 到 `~/.dsh/jarvis-sphere/chronicle.jsonl`（可用 `chronicleDir` 改）：

- 只记 `{时间, 日期, 会话短 id, 用户那句话的前 80 字, 本轮工具数}`，**不记助手输出**；
- **按会话隔离**：标签与工具基线挂在各自的 pending 上，工具调用也按会话累加（`sessionTools`），两个会话并行时既不串标签、也不互涨工具数；
- **子代理回合不计入**（`session.header.origin === 'subagent'` 跳过）：「今天第几件事」指人发起的回合；
- **注入块不当成你说的话**（插件收不到 `user/message` 事件时，会在每回合第一步从会话消息里读回你那句话）：`<system-reminder>`、`Time sampled…`、`[MNEMON]` 开头的块被跳过；控制字符与换行压平，按码点截断不劈代理对；
- 文件超过 512 KB 时**按字节**从尾部回收到 ≤80% 预算（且 ≤2000 行）；临时文件名带 pid，rename 失败会清掉，不留半截或 `.tmp`；
- 重启时聚合整个（有界的）文件恢复当天计数，不是只看尾部几百行；HUD 多一段 `N TODAY`；
- 只读工具 `jarvis_chronicle` 返回今天 / 最近 7 天概览 + 最近 N 条记录，时间按**本地时区**显示；
- `chronicle: false` 可整体关掉（不写文件、不注册工具）。

## 自检：`jarvis_doctor`

一个只读诊断工具，也是「坏了能自己说」的地基。它检查九个通道，`DEGRADED` / `FAIL` 的条目会附一句修法：

| 检查 | 判据 | 典型修法 |
| --- | --- | --- |
| `route` | state 路由挂在主路径还是备用路径 | 备用路径说明旧实例还占着主路径，重启 DSH 清掉 |
| `persona` | `jarvis:persona` section 是否真的注册（带版本号） | systemPrompt 不在位时人格等于没生效 |
| `memory` | Mnemon 存储根可读、条目/文档数 | 用 `memoryDirs` 指到正确目录 |
| `chronicle` | 目录可写；未创建时报 degraded（诊断本身不建目录，首个回合才建） | 检查 `chronicleDir` 权限，祖先若是文件直接 fail |
| `services` | agents / tokenMeter / schedule / tools / systemPrompt / webServer 是否在位 | 缺服务说明 profile 组合被改过 |
| `caches` | 记忆/上下文缓存年龄、schedule 读取是否卡死 | 卡死的读取 10 秒后自动重试 |
| `detail` | 只读详情路由 `GET /dsh-jarvis/detail` 是否注册 | 没注册时点球打不开面板 |
| 	ools | 五个只读工具/通道**实际**注册成功与否（keeper / chronicle / doctor / backup / alerts；alerts 还要提醒上下文注册成功，失败会如实报 missing） | tools 服务不可用时全部降级；全缺=fail、缺部分=degraded |
| `backup` | 最新归档是否存在、manifest 是否可读、是否超过 14 天、是否被截断或复制失败 | 没有归档/损坏/过期/不完整都报 degraded，并指向 `jarvis_backup create` |

结论只有 `OK / DEGRADED / FAIL / SKIP` 四档；任何服务缺失或抛错都只降级对应通道，不让插件挂掉。
报告缓存 5 秒（诊断要 stat 文件和探测服务，不能跟着 140ms 轮询跑）。
HUD 在 FAIL 时多一段 `DOCTOR FAIL`，DEGRADED 时多一段 `DOCTOR`。

另外加了 `test/import-smoke.mjs`：除了用当前 Node 导入入口模块，还会用**宿主自带的 Node** 再导一次——
这次就是靠它之外的一次真机加载抓到了 `import { W_OK } from 'node:fs'`（PATH 上的 Node 22 容忍、宿主 Node 24 直接拒绝激活）这类只在宿主上才炸的问题。
## 记忆地基：`jarvis_backup`

一条命令把「让 JARVIS 成为 JARVIS」的东西打包：Mnemon 运行库（memories.json / USER.md / MEMORY.md）、文档索引与正文、**记忆空间正文库（data/**/mnemon.db 及其 -wal/-shm）**、归档的运行记录、编年史、`persona.md`、插件配置。

- `action=status`（默认）：归档目录、最新一份的时间与体积、总份数；
- `action=create`：生成 `~/.dsh/jarvis-sphere/backups/jarvis-<时间戳>/`，内含 `manifest.json`（每个文件的字节数与 sha256），默认只留最近 7 份（`backupKeep`）；
- `action=verify`：**逐文件重新哈希**，损坏或缺失会点名；**畸形 manifest（不是数组、坏条目、非法 JSON）只报原因不抛错**；通过后打印精确到目标文件的恢复清单；
- **不做自动恢复**：运行中的 Mnemon 持有这些文件，自动回灌会被它覆盖。`verify` 给出的是校验过的复制清单，复制后重启 DSH 生效；
- 医生（`jarvis_doctor`）多一项 `backup` 检查：没有归档或最新一份超过 14 天 → `DEGRADED`，并直接告诉你跑 `create`。

实测：第一份归档 79 个文件 / 561 KB（记忆 15 条 + 文档 70 篇 + 编年史 + 人格 + 配置）。
## 主动提醒：从「显示」到「塞进下一步」

宿主没有系统级通知通道（只有账号通知），所以提醒走的是 DSH 自己的提示注入：`systemPrompt.context()` 注册一条运行时上下文，**每一步装配提示时都会重新求值**——问题不用等你看球，下一轮我就会当面说。

| 触发条件 | 级别 | 文案 |
| --- | --- | --- |
| 上下文压力 ≥ 85% | warn | 建议压缩或新开会话 |
| 记忆库已用 ≥ 90% | warn | 建议归档旧条目（指向 `jarvis_memory_review`） |
| 15 分钟内错误 ≥ 3 次 | warn | 报次数 |
| 定时任务 ≤ 30 分钟到期 | info | 30 分钟内到期（不含分钟数，避免每步改写上下文） |
| 自检有 FAIL 通道 | warn | 点名通道（指向 `jarvis_doctor`） |
| 没有备份 / 备份不可读 / 超 14 天 | info / warn | 指向 `jarvis_backup create` |

机制上三条约束：
- **冷却语义**：告警一旦激活就一直在最新上下文里（DSH 只在内容变化时追加一条快照，不会每步重发）；条件消失后自动撤下，并从撤下时刻起算 30 分钟冷却——这段时间内同一条件回来会被压住，超过 30 分钟才重新提醒；
- **`jarvis_alerts action=ack` 可以确认**（全部或按 id），确认后条件消失前不再提醒；
- 上下文按**紧急程度**取前 4 条（errors / due / doctor → warn → info），被藏起来的条目会有一行「另有 N 条提醒」；`count` 始终是全部条数；快照只留 `{count, active:[{id, level, text}]}`（4 条约 350 字节，实测 348 B）；
- `alerts: false` 一并关掉上下文和工具。

HUD 多一段 `N ALERT`（在 DOCTOR 之后）。
## 执行通道：`jarvis_memory_apply`

`jarvis_memory_review` 只出建议；这个工具把「确认」变成动作，但三条规矩不变：

- **默认预演**：不加 `confirm: true` 只返回计划（条目数/字节数变化、要删哪些、要加什么），不碰文件；
- **只碰 Markdown 投影**（`MEMORY.md` / `USER.md`），**绝不直接改 Mnemon 的 SQLite 正文库**——那边由 Mnemon 自己维护一致性；
- **写前必留证据**：先整库归档（复用 `jarvis_backup`），被删的原文另存 `runtime/archived/manual/<文件>.<时间戳>.md`，文件用临时文件 + rename 原子替换，写后重新解析核对条目数，并把 `{时间, 动作, 条目, 快照, 归档}` 追加进 `~/.dsh/jarvis-sphere/memory-audit.jsonl`。

动作：`archive`（移出并归档）、`delete`（删除，原文同样归档）、`rewrite`（原地改写**恰好一条**）、`merge`（多条合成一条，需 ≥2 条）。
选择器：`entries: [1-based 序号]`（序号来自 `jarvis_memory_review` 的列表）＋可选 `expected: ["预览片段"]`——**文件自复查以来变过就拒绝写入**，避免序号漂移改错记忆。

实现细节（都是被复查打回来过的地方）：
- 换行风格跟随原文件：CRLF 文件写回仍是 CRLF；
- 「单条目」按独立一行的 `§` 判定，`\r\n§\r\n`、`\n § \n`、`\n§\r\n` 这些变体同样算多条，会被拒绝；
- 同一毫秒连续写入得到两份不同归档（毫秒时间戳 + 独占创建 + 序号后缀），不会互相覆盖；
- `rename` 失败时临时文件与本次归档都会被清掉，不留残留；
- 快照不完整（有源复制失败，或目标文件没有可校验副本）**直接拒绝写入**；
- 写后重新解析，条目数与预期不符会返回 `ok: false` 并提示重跑 `jarvis_memory_review`；审计写不进去会 warn，不会假装成功。

实测：`archive` 第 2 条 → 文件 3 条变 2 条、原文进归档、审计一行、快照存在；`target: 'user'` 只动 `USER.md`，`MEMORY.md` 字节不变。
## 球主界面（档 2）：球居中，对话浮在右侧

`stage: true`（或运行时按 **Ctrl+Shift+K**）进入档 2：

- 球移到左半屏中央并放大，成为主视觉；
- 对话列（从输入框向上找到的高而宽的容器）被抬成右侧浮层卡片：`min(46vw, 760px)`、圆角、半透明、可滚动，DSH 自身布局不改 DOM 顺序，退出时按原 `style` 还原；
- 顶部 HUD、点击面板、事件闪点都跟着球走；
- `Ctrl+Shift+J` 仍是沉浸模式，两种模式可叠加；
- 状态存 `localStorage`，刷新后保持。

**边界**：档 2 依赖运行时测量（没有硬编码 DSH 类名），如果某次 DSH 改版导致找不到「高且宽」的容器，抬卡会跳过，球仍会移到中间——不会白屏。
## 任务时带记忆（E）：场景识别 + 相关记忆

当一句话或一个工具名提到某类工作（Unity / 3DS Max、DSH 插件、记忆库、企业微信、laundry-xiaoai），
插件把「当前场景」记下来，并做两件事：

- 在每步的系统提示上下文里加一行：`当前场景：Unity / 3ds Max（相关记忆可用 jarvis_context action=find 取回，先看再答）`——只在我需要时出现，10 分钟后自动失效；
- 提供只读工具 `jarvis_context`：`action=list` 看当前场景，`action=find` 按场景关键词从记忆库里挑出相关条目（最多 20 条，每条截 80 字）。

面板「状态」页同样显示当前场景。场景是进程级单例（所有会话共享），子代理的工具调用也会更新它。`scene: false` 关掉整块（提示与工具都不注册）。
## 事件闪点（D）：今天在球上留下的痕迹

工具调用与错误会在球面留下会扩散的圆环，约 30 秒淡出——「今天做了什么」不只在 HUD 数字里。

- Host 只记两类：`tool/call` → 紫色环，`agent/error` → 红色环；回合结束不打点；
- 快照带一个**有界**的最近事件环（最多 12 条、只发 30 秒内的，实测 < 700 B），Client 按单调序号去重，新事件才生成涟漪；
- 位置由事件序号哈希成球面固定点，同一事件不会乱跳；涟漪随时间扩散变淡；
- `pulse: false` 整块关掉（Host 不发、Client 不画）。
## 可点击球体（C）：点球开只读面板

单击球体（背景区域）打开一个浮层，顶部有七个页签：

| 页签 | 内容 |
| --- | --- |
| 状态 | 记忆条数/文档数、提醒数、待复盘数、备份份数 |
| 记忆 | 条目/文档/空间计数 + 最近 8 条（重要性 + 前 60 字） |
| 提醒 | 待处理告警与级别 |
| 待复盘 | 队列里的规则原文 |
| 备份 | 目录、最新归档、份数、体积 |
| 自检 | 十一通道逐项状态 |
| 编年史 | 今天轮次/工具 + 最近 6 轮标签 |

- 数据来自新只读路由 `GET /dsh-jarvis/detail?kind=...`（与 state 同源鉴权，只读，不写任何文件）；
- **不抢页面点击**：选中文字、点按钮/链接/输入框、拖滚动条都不会触发；只有落在球体半径内且目标非交互元素才打开；
- `Esc` 或点面板外关闭；面板是 DOM，不依赖 DSH 类名，停用插件即消失。
## 日报（B）：`jarvis_report`

一条命令把「今天」写成 Markdown，落在 `~/.dsh/jarvis-sphere/reports/YYYY-MM-DD.md`：

- **今天做了什么**：轮次/工具数 + 当天最近几轮的标签；
- **记忆**：MEMORY/USER 占用比例、条目/文档/空间数、待复盘条数；
- **自检**：十一通道逐项状态；
- **备份**：目录、最新归档、份数、年龄；
- **提醒**：当前未处理的告警。

`action=list` 列最近 N 份，`action=read` 取某一天的正文，`day=YYYY-MM-DD` 可补历史。`report: false` 关掉。

边界：**只写报告文件，不碰记忆**；日报不自动定时（要定时得你明确要求，我再建计划任务）。
## 自动复盘（A）：可疑规则先进队列

你说的话里如果带「以后／记住／必须／不要再／下次／从现在起／我更喜欢」这类词，插件不会直接写记忆，而是**先记进待复盘队列**，并注入一条提醒；我看到后会问你「要不要收录」。

- 队列文件：`~/.dsh/jarvis-sphere/review-queue.json`（最多 20 条，同文本去重）；
- 工具 `jarvis_recap`：`list` 看队列、`confirm` 表示已收录、`drop` 丢弃；
- 队列非空时告警通道会多一条 `N 条待复盘`（在 HUD/提示里可见）；
- `recap: false` 关掉整套（不建队列、不注册工具、不告警）。

边界：**它只提议，不落盘**。真正的记忆写入仍要经 `jarvis_memory_apply` 或 `mnemon_runtime_memory`，且由你确认。
## 沉浸模式（档 1）：球当主界面

按 `Ctrl+Shift+J` 切换。开启后：

- 球放大到 `min(视口) × 0.46`（正常 0.315），铺满整屏；
- 页面底色压到近黑，对话框/输入区/侧栏变成半透明（`backdrop-filter: blur(3px)`），文字仍可读；
- HUD 移到顶部（正常模式在球下方），下一行是工具详情，再下一行提示 `沉浸模式 · Ctrl+Shift+J 还原`；
- 状态写进 `localStorage`，刷新后保持；再按一次切回原界面。

实现边界：只改页面 CSS 与自己的 canvas，不碰 `app.asar`；面板不靠类名，而是从输入框往上找 5 层容器标记 `data-jvs-panel`，所以 DSH 前端小改版也能用。停用插件即完全恢复。
## 画了什么

从下往上十一层，全部 Canvas 2D，没有 WebGL、没有外部依赖：

| 层 | 说明 |
| --- | --- |
| 全息球壳 | 7 条纬线 + 6 条经线组成的三维线框球，带极轻微的亮度抖动（全息闪烁） |
| 神经元 | 斐波那契球节点 + 3 近邻连线，**按深度 4 档 × 光照 3 档**批量填充，左上前方打光 |
| 记忆光点 | 一槽一颗：外晕 + 亮核 + 细环，按类型配色、按重要度定大小、按年龄褪光、按条数放大 |
| 文档刻度环 | 外圈 96 格绿色刻度，长亮不定，文档越多越密 |
| 越球数据弧 | 沿大圆从节点 A 飞到节点 B 的弧线，头部是亮点，工具调用时必发 |
| 火花 | 沿连线滑动的彗星，带短线拖尾 |
| 同心倾斜环 | 两圈带刻度的椭圆轨道，反向缓慢旋转，其中大刻度更亮 |
| 准星括弧 | 球体四角的弧形括弧 + 端点，HUD 味道 |
| 水平扫描带 | 从上往下慢慢扫过球面的光带（只在有活动时出现） |
| 冲击波 | 工具调用时从球心外扩的琥珀色圆环 |
| 泛光 bloom | 四分之一分辨率的亮部提取 + 模糊 + 加法合成，让亮点真的"发光" |

HUD 首行是 `JARVIS · 运行中/待机 · !N 错误 · N 记忆 xx% · 上下文 xx% · 今日 N · N 任务 · N 工具`；没有工具在跑时第二行报 `NEXT <多久后>` 或记忆库存
（`MEMORY  2 USER · 12 WORKING · 2 SPACES · 58 DOCS`）。

球心用 `destination-out` 挖空，事件视界是一圈虚线环——正文正好落在里面。

## 装

```bash
dsh plugin --profile <your-profile> add github:nixuejun888/dsh-jarvis-sphere
```

装完刷新一次 Web 界面即可看到。也可以本地目录安装：**插件** → **添加插件** → 选这个目录。

停用：插件页把 `jarvis-sphere` 关掉，重启 DSH。

## 它到底吃了哪些数据

Host 半边（`index.js`）挂在 `GET /dsh-jarvis/state` 上，把下面这些折成一个约 1.8–2 KB 的快照（空闲典型值；记忆条目多时由 460 个哈希槽位封顶，5,000 条实测约 22 KB）：

| 事件 | 用途 |
| --- | --- |
| `agent/status` | 判断有没有 Agent 在跑 → 基础能量 |
| `agent/assistant-stream` | 2.5 秒滑窗内的帧率 → 脉冲密度、转速、底部环形表 |
| `session/event` · `tool/call` | 工具调用 → 冲击波、数据弧、火花、HUD 工具名 |
| `session/event` · `tool/result` | 收尾活动中的工具 |
| `session/event` · `turn/end` · `assistant/message` | 轮次 / 消息计数 |
| `subagent/start`、`agent/error` | 子代理数、错误计数 |

Client 半边（`client.js`）注册进 `shell.overlay` 槽位；不读 DOM、不改主题、不写会话日志。

## 调

改本目录 `cordis.patch.yml` 里 `jarvis-sphere` 那一行的 `config`：

```yaml
- insert:
    - id: jarvis-sphere
      name: dsh-jarvis-sphere
      config:
        enabled: true      # 整个浮层开关
        nodeCount: 460     # 节点数 80–1400
        intensity: 1       # 能量强度 0–3
        opacity: 1         # 不透明度 0–1
        showHud: true      # 球下方状态文字 + 底部环形表
        glow: true         # 泛光（关掉更省，也更素）
        color: cyan        # cyan | blue | green | amber | violet
        offsetX: 0         # 球心相对窗口中心的偏移
        offsetY: 0
        persona: true      # 永久人格（写进每个会话的系统提示）
        # personaFile: 'C:\\绝对路径\\persona.md'   # 指定人格文件；留空用包内 persona.md
        personaText: ''    # 覆盖内置人设正文
        memoryDirs: []     # 额外探的记忆根目录，默认取 dsh-mnemon 的 dataDir
        memorySlots: 0     # 记忆槽位数；0 = 跟随 nodeCount（上限 1400）
        keeper: true       # 注册只读审计工具 jarvis_memory_review
        chronicle: true    # 每个回合写一行编年史
        backup: true       # 记忆地基归档（jarvis_backup）
        # backupDir: 'C:\绝对路径\'   # 归档目录；空 = ~/.dsh/jarvis-sphere/backups
        backupKeep: 7      # 保留几份
        alerts: true       # 主动提醒（运行时提示注入 + jarvis_alerts）
        memoryWrite: true  # jarvis_memory_apply（默认预演，写前自动归档）
        # chronicleDir: 'C:\绝对路径\'   # 编年史目录；空 = ~/.dsh/jarvis-sphere
```

改完在插件页重启该 bundle（或重启 DSH）。

## 验收

- 空闲：球在转、颜色偏暗、HUD 显示 `JARVIS · STANDBY · 13 MEM`。
- 让它做一件事（比如跑一条命令）：球变亮变快、显示 `ACTIVE`，工具调用时出现琥珀冲击波并划过数据弧。
- 球面上有琥珀（用户画像）、冷白（工作记忆）、紫（记忆空间）、绿（文档）四色光点；新写一条记忆会多一颗。
- 新开会话或子代理：系统提示里带同一套 JARVIS 人设（问它「你的系统提示里刻了什么人格」可验证）。
- 聊天正文照常可读、可点、可选中。

Host 半边的单元断言：

```bash
node test/host-smoke.mjs    # 21/21  工具计数、收尾、轮次、405、卸载清路由
node test/reload-smoke.mjs  # 15/15  路由生命周期：停用释放、重启用、旧路由占位、备用路径
node test/memory-smoke.mjs  # 32/32  记忆聚类（5,000 条不截断）+ 存储根发现 + 人格 section + 仪表接线
node test/keeper-smoke.mjs  # 25/25  只读审计：容量/重复/陈旧/过长 + 预览脱敏
node test/health-smoke.mjs  # 31/31  仪表 + 人格：缓存 TTL、比例语义、错误剪枝、快照尺寸、服务全挂、TDZ、人设来源与版本
node test/report-smoke.mjs  # 33/33  日报：五段内容、历史日计数与标签、read 读磁盘、非法日、余量、原子写
node test/recap-smoke.mjs   # 14/14  自动复盘：入队、去重、提醒、confirm/drop、确认后不再入队、可关闭
node test/chronicle-smoke.mjs # 38/38  编年史：一回合一行、会话隔离、注入块与中文快照过滤、重启恢复、按字节轮换、可关闭
node test/doctor-smoke.mjs  # 32/32  自检：十通道 + 健康全绿、目录未建、工具拒绝
node test/scene-smoke.mjs   # 22/22 场景：指令/工具名识别、提示、jarvis_context、10 分钟失效、可关
node test/import-smoke.mjs  # 4/4   入口模块在当前 Node 与宿主 Node 下都能导入
node test/writer-smoke.mjs  # 46/46  执行通道：选择器防漂移、四种动作、预演零写入、同毫秒归档去重、失败清理、CRLF 保持、白名单
node test/backup-smoke.mjs  # 36/36  归档：源发现（含 SQLite 库）、畸形 manifest 不抛、篡改/缺失检出、id 互通、毫秒去重、轮换、状态
node test/alert-smoke.mjs   # 40/40  提醒：六类阈值、优先级截断与「另有 N 条」、ack 释放与复活、字符串/非数组 id、提示注入、关闭
node test/panel-smoke.mjs   # 23/23  可点击球体：七种 kind、405/HEAD、路径穿越、禁用通道、余量、卸载释放
node test/pulse-smoke.mjs   # 8/8   事件闪点：工具/错误入环、回合不打点、有界、可关
```

## 路由生命周期（0.2.3-alpha.2 兼容修复）

1.0.0 把 `/dsh-jarvis/state` 直接 `ctx.webServer.register(...)` 注册，只把返回的 disposer 塞进
`apply` 内的 `disposers`，而**加载器会忽略 `apply` 的返回值**。该版本上实测后果：

- 关掉插件那一行，路由仍留在进程里继续应答（数据冻结在关闭那一刻）。
- 再打开时 `apply` 撞上 `webserver: duplicate exact route "/dsh-jarvis/state"`，整行激活失败。

现在的做法：

1. 路由注册放进 `ctx.effect(...)`，与插件生命周期绑定：停用即释放，重新启用可重注册。
2. 快照 `build` 升到 `3`；若本进程里仍被旧实例占着主路径（旧版泄漏、无法回收），新实例改注册
   `/dsh-jarvis/state-v2`，Client 半边只认 `build >= 3`，主路径返回旧快照时自动改投备用路径。
   重启一次 DSH 后进程干净，会重新回到主路径，备用路径不再使用。
3. `test/reload-smoke.mjs` 覆盖上述生命周期（停用释放、重启用、旧路由占位、备用路径接管）。

## 已知限制

- 数据是 140–450ms 粒度的轮询快照，不是逐 token 推送；视觉上够用，但不是严格实时。
- 记忆光点按 3 秒粒度重读存储根，刚写入的记忆最多慢 3 秒才亮；槽位数固定，条目暴增时是「光点变亮」而不是「长出更多点」。
- 人格是**提示文本**，不是权限或能力：它改语气与工作习惯，不改工具、不覆盖用户指令。
- 泛光依赖 `ctx.filter`；不支持的环境会自动跳过（不会糊成一片白）。
- 球体按窗口居中定位（用 `offsetX` 微调），不感知侧栏宽度变化。
- HUD 文字绘制在 canvas 上，是水印性质，不参与界面缩放与本地化。
- 实测渲染开销：单核约 5%（整机 0.3%）；记忆槽位与文档刻度数量固定，与条目总数无关。

## License

MIT


