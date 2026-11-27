# JARVIS 球 · 记忆神经元球

![A holographic neuron sphere with memory dots, JARVIS HUD and the floating conversation column](preview.jpg)

一个常驻 DSH Web 界面的全息神经元球，同时是三样东西：

1. **一个显示器**——球体的转速、亮度、脉冲、冲击波，全部由当前任务真实执行的数据驱动；
2. **一张记忆地图**——球面上每一颗光点是一条真实记忆，位置永不变，颜色区分类型，亮度区分重要度与新鲜度；
3. **一个操作员**——往每个会话注入 JARVIS 人格，并带 9 个工具：审计记忆、归档备份、写编年史、出日报、做自检、认场景、管提醒。

整层 `pointer-events: none`（球体本身可点开只读面板），不影响任何操作。

## 三件事怎么对应

| 你看到的 | 它是什么 |
| --- | --- |
| 光点 | 一条记忆：琥珀＝用户画像，青白＝工作记忆，紫＝记忆空间，琥珀×青＝槽位合并 |
| 光点大小/亮度 | 重要度（critical / normal / low）× 冷热度；24 小时内写过的会呼吸 |
| 外圈 96 格刻度环 | 文档归档密度（文档不占球面槽位） |
| 转速、亮度、脉冲密度 | 有没有 Agent 在跑 + 模型流式输出速率 |
| 琥珀冲击波、越球数据弧、火花 | 每一次工具调用、每一次报错 |
| 记忆飞入弧 | 新写入一条记忆 |
| 底部 HUD | 运行态、记忆数、记忆占用、上下文占用、任务数、工具数 |

**正文永不下发。** 快照里只有 `{槽位, 类型, 条数, 重要度, 年龄, 新鲜}` 与 96 个文档计数——没有条目正文、没有文档标题。内存中没有条数上限：460 个哈希槽位封顶，多条记忆撞进同一槽就合并成一颗更大更亮的光点。

## 9 个工具

| 工具 | 干什么 |
| --- | --- |
| `jarvis_context` | 当前场景 + 与该场景相关的记忆（先看再答） |
| `jarvis_memory_review` | 记忆审计（只读）：容量、重复、过期、超大条目 |
| `jarvis_memory_apply` | 执行一条审过的记忆决策（archive / delete / rewrite / merge，默认 dry run） |
| `jarvis_backup` | 记忆地基：归档记忆、文档、编年史、人格、配置；可校验 |
| `jarvis_chronicle` | 今天/本周干了什么（只读编年史） |
| `jarvis_doctor` | 十一项自检，每项给 OK / DEGRADED / FAIL 和修法 |
| `jarvis_report` | 日报，写成 Markdown 落在编年史目录下 |
| `jarvis_recap` | 复盘队列：听起来像长期规则的话先进队列，等人确认 |
| `jarvis_alerts` | 主动提醒列表与确认（上下文压力、记忆容量、近期报错、到期任务） |

## 三种版式

`stage` / `full` 两个开关组合出三档：

| 档 | 配置 | 效果 |
| --- | --- | --- |
| 1 背景层 | `stage: false, full: false` | 球在聊天背后（本仓库 patch 当前就是这一档） |
| 2 球主界面 | `stage: true` | 对话浮在右侧窄栏，球独占中间 |
| 3 全屏球 | `full: true` | 通体只有球，对话收到底部，面板从抽屉滑入 |

## 配置

改 `cordis.patch.yml` 里 `jarvis-sphere` 那行的 `config`，改完在插件页重启该 bundle。

**外观**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 整个浮层开关 |
| `nodeCount` | `460` | 节点数 80–1400 |
| `gauge` | `glow` | 底部仪表样式：`glow` 光晕 / `arc` 旧弧线 |
| `intensity` | `1` | 能量强度 0–3 |
| `opacity` | `1` | 整体不透明度 0–1 |
| `showHud` | `true` | 底部状态条 + 环形表 |
| `glow` | `true` | 泛光（关掉更省更素） |
| `color` | `cyan` | `cyan` / `blue` / `green` / `amber` / `violet` |
| `offsetX` / `offsetY` | `0` | 球心相对窗口中心的偏移 |
| `stage` / `full` | `false` | 见上面三种版式 |

**记忆与人格**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `persona` | `true` | 往每个会话系统提示注入 `jarvis:persona` |
| `personaText` | `''` | 覆盖内置人设正文 |
| `personaFile` | 包内 `persona.md` | 用外部文件当人设 |
| `memoryDirs` | `[]` | 优先探测的 Mnemon 存储根 |
| `memorySlots` | `0` | 哈希槽位数，0 = 跟随 `nodeCount` |
| `memoryWrite` | `true` | 允许 `jarvis_memory_apply` 写 MEMORY.md / USER.md |

**记录与守护**

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `keeper` | `true` | 注册只读的 `jarvis_memory_review` |
| `chronicle` | `true` | 每轮结束写一行编年史 |
| `chronicleDir` | `~/.dsh/jarvis-sphere` | 编年史目录（日报也写这里） |
| `backup` | `true` | 一键归档 |
| `backupDir` | `~/.dsh/jarvis-sphere/backups` | 归档目录 |
| `backupKeep` | `7` | 保留几个归档 |
| `alerts` | `true` | 主动提醒塞进下一步的运行时上下文 |
| `recap` | `true` | 复盘队列 |
| `report` | `true` | 日报工具 |
| `pulse` | `true` | 事件闪点：工具调用/报错在球面留短痕迹 |
| `scene` | `true` | 场景识别 + 相关记忆 |

## 快照与路由

- Host 半边把 `agent/status`、`agent/assistant-stream`、`session/event`（`tool/call`、`tool/result`、`turn/end`、`assistant/message`、`step/*`）、`subagent/start`、`agent/error` 折进一个快照，挂在 owner-only 的 `GET /dsh-jarvis/state`。
- 快照空闲约 2 KB；记忆多时由 460 个哈希槽位封顶（5,000 条 + 300 篇文档实测约 22 KB，一条不丢）。
- 客户端带 `build` 版本闸门（`>= 4`），会跳过老实例留下的冻结路由；主路由被占时自动降级到 `/dsh-jarvis/state-v2`。
- 客户端用 Canvas 2D，节点按深度 4 档 × 光照 3 档批量填充，连线按深度 3 档批量描边；泛光走四分之一分辨率的亮部 + 模糊 + 加法合成，不支持 `ctx.filter` 的环境自动跳过。

## 已知限制

- 数据是 140–450ms 粒度的轮询快照，不是逐 token 推送。
- 记忆正文与文档标题永不下发，所以看不到具体内容，只看到"有、多重、多新"。
- 球体按中心列定位（`offsetX` / `offsetY` 可微调），不跟随侧栏折叠。
- 编年史与备份都写在 `$DSH_HOME/jarvis-sphere` 下；换机器要自己搬。
- 主动提醒是"塞进下一步上下文"，不是弹窗——它不会打断你。

## 参考

- 泛光做法：[Cheap bloom for a Canvas 2D game in 8 lines](https://dev.to/nightdrivelabs/cheap-bloom-for-a-canvas-2d-game-in-8-lines-no-webgl-4jah)
- 构图思路：[JARVIS HUD 里元素贴在包围观察者的透明球面上、同心底层排布并带倾角](https://uxdaystokyo.com/articles/vertical_surface_corners/)
