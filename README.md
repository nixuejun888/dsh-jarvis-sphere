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

球体不只会动，它报健康。HUD 首行是
`JARVIS · ACTIVE · 14 MEM 77% · CTX 68% · 7 TODAY · 2 TASKS · 4 TOOLS`，告警（`!N ERR`）排在最前。

| 通道 | 数据源 | 渲染 |
| --- | --- | --- |
| 记忆容量 | `MEMORY.md 已用 / dsh-mnemon 真实上限`（一次 stat，5 秒缓存） | 球体**上方**一圈琥珀弧，≥85% 转琥珀并染色 HUD |
| 上下文压力 | `tokenMeter.contextPressure(session)`，取**最忙会话**的占用率（2 秒缓存） | 再外一圈紫弧，≥85% 转红；比例 clamp 到 1 |
| 待办 | `schedule.list({active:true})`（30 秒缓存，带 10 秒 inflight 超时） | `N TASKS`；没工具在跑时第二行显示 `NEXT <多久后>` |
| 近期错误 | `agent/error` 时间戳（15 分钟窗口，4096 上限） | `!N ERR` 并把整行染成告警色（主题相关） |

实现约束（都是被复查打回来过的地方）：

- 两条压力弧画在球体**上方**，不压底部文字；半径按 `R*1.045 / R*1.07` 取比例，窗口再小也不重叠；
- HUD 按优先级拼装（ERR → MEM → CTX → TODAY → TASKS → TOOLS），超出预算就丢末尾，不出现 `...`；
- 快照只带 Client 真正读的 9 个 cfg 键，`personaText` 之类的配置不上线；
- 错误窗口一次扫描 + 一次 `splice` 剪枝，并在写入处就压到 4096，页面关久了重开也不会卡住 Host；
- 事件窗口（流式帧 / 工具调用 / 错误）都有 4096 硬上限；
- 任何服务缺失或抛错都只让对应通道降级为 0，绝不让 `apply` 抛错。

## 编年史：今天第几件事

每个回合结束写一行 JSON 到 `~/.dsh/jarvis-sphere/chronicle.jsonl`（可用 `chronicleDir` 改）：

- 只记 `{时间, 日期, 会话短 id, 用户那句话的前 80 字, 本轮工具数}`，**不记助手输出**；
- **按会话隔离**：标签与工具基线挂在各自的 pending 上，工具调用也按会话累加（`sessionTools`），两个会话并行时既不串标签、也不互涨工具数；
- **子代理回合不计入**（`session.header.origin === 'subagent'` 跳过）：「今天第几件事」指人发起的回合；
- **注入块不当成你说的话**：`<system-reminder>`、`Time sampled…`、`[MNEMON]` 开头的块被跳过；控制字符与换行压平，按码点截断不劈代理对；
- 文件超过 512 KB 时**按字节**从尾部回收到 ≤80% 预算（且 ≤2000 行）；临时文件名带 pid，rename 失败会清掉，不留半截或 `.tmp`；
- 重启时聚合整个（有界的）文件恢复当天计数，不是只看尾部几百行；HUD 多一段 `N TODAY`；
- 只读工具 `jarvis_chronicle` 返回今天 / 最近 7 天概览 + 最近 N 条记录，时间按**本地时区**显示；
- `chronicle: false` 可整体关掉（不写文件、不注册工具）。

## 自检：`jarvis_doctor`

一个只读诊断工具，也是「坏了能自己说」的地基。它检查七个通道并给每条结论配一句修法：

| 检查 | 判据 | 典型修法 |
| --- | --- | --- |
| `route` | state 路由挂在主路径还是备用路径 | 备用路径说明旧实例还占着主路径，重启 DSH 清掉 |
| `persona` | `jarvis:persona` section 是否真的注册（带版本号） | systemPrompt 不在位时人格等于没生效 |
| `memory` | Mnemon 存储根可读、条目/文档数 | 用 `memoryDirs` 指到正确目录 |
| `chronicle` | 目录可建且可写 | 检查 `chronicleDir` 权限 |
| `services` | agents / tokenMeter / schedule / tools / systemPrompt / webServer 是否在位 | 缺服务说明 profile 组合被改过 |
| `caches` | 记忆/上下文缓存年龄、schedule 读取是否卡死 | 卡死的读取 10 秒后自动重试 |
| `tools` | 三个只读工具是否注册成功 | tools 服务不可用时全部降级 |

结论只有 `OK / DEGRADED / FAIL / SKIP` 四档；任何服务缺失或抛错都只降级对应通道，不让插件挂掉。
报告缓存 5 秒（诊断要 stat 文件和探测服务，不能跟着 140ms 轮询跑）。
HUD 在 FAIL 时多一段 `DOCTOR FAIL`，DEGRADED 时多一段 `DOCTOR`。

另外加了 `test/import-smoke.mjs`：除了用当前 Node 导入入口模块，还会用**宿主自带的 Node** 再导一次——
这次就是靠它之外的一次真机加载抓到了 `import { W_OK } from 'node:fs'`（PATH 上的 Node 22 容忍、宿主 Node 24 直接拒绝激活）这类只在宿主上才炸的问题。
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

HUD 首行是 `JARVIS · ACTIVE/STANDBY · !N ERR · N MEM xx% · CTX xx% · N TODAY · N TASKS · N TOOLS`；没有工具在跑时第二行报 `NEXT <多久后>` 或记忆库存
（`MEMORY  2 USER · 12 WORKING · 2 SPACES · 58 DOCS`）。

球心用 `destination-out` 挖空，事件视界是一圈虚线环——正文正好落在里面。

## 装

```bash
dsh plugin --profile <your-profile> add github:nixuejun888/dsh-jarvis-sphere
```

装完刷新一次 Web 界面即可看到。也可以本地目录安装：**插件** → **添加插件** → 选这个目录。

停用：插件页把 `jarvis-sphere` 关掉，重启 DSH。

## 它到底吃了哪些数据

Host 半边（`index.js`）挂在 `GET /dsh-jarvis/state` 上，把下面这些折成一个约 300 字节的快照：

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
node test/chronicle-smoke.mjs  # 32/32  编年史：一回合一行、会话隔离、注入块过滤、控制字符、重启恢复、按字节轮换、可关闭
node test/doctor-smoke.mjs  # 17/17  自检：健康全绿、服务缺失降级、目录不可写 FAIL、报告缓存
node test/import-smoke.mjs  # 4/4   入口模块在当前 Node 与宿主 Node 下都能导入
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





