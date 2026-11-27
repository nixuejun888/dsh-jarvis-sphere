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
`data/.dsh-memory-bodies.json`、`documents/index.json`），把每一条记忆钉到球面上一颗固定光点上：
位置由内容哈希决定（重启后仍落在同一处），颜色分四类——

| 光点 | 来源 | 颜色 |
| --- | --- | --- |
| 用户画像 | USER.md 条目 | 琥珀 |
| 工作记忆 | MEMORY.md 条目 | 冷白青 |
| 记忆空间 | 已注册的记忆空间 | 紫 |
| 文档 | Documents 库 | 绿 |

大小和亮度跟重要度（critical / normal / low）与新鲜度走：旧记忆会变暗但不会熄灭，24 小时内写过的会呼吸。
**条目正文永远不离开 Host**——快照里只有 `{类型, 重要度, 年龄, 内容哈希}`，正文和其它文档标题都不下发到页面。

**永久人格。** Host 半边同时往系统提示里注册一个全局 section（`jarvis:persona`，order 100，
紧跟在 `deployment:persona-prefix` 之后），所以每一个会话——包括子代理和新建会话——都带着同一套
JARVIS 语气与工作习惯，而不是只在这个会话里临时生效。它是提示文本，末尾明确写着：
即时指令、准确性、安全与工具规则一律高于人设。

- 关掉人格：行配置 `persona: false`；换掉正文：`personaText: "..."`。
- 记忆根目录默认从 `dsh-mnemon` 的运行配置里取 `dataDir`，再退回 `~/.mnemon`；可用 `memoryDirs: [...]` 覆盖。
- 光点上限 `maxMemoryNodes`（默认 120）。

## 画了什么

从下往上十层，全部 Canvas 2D，没有 WebGL、没有外部依赖：

| 层 | 说明 |
| --- | --- |
| 全息球壳 | 7 条纬线 + 6 条经线组成的三维线框球，带极轻微的亮度抖动（全息闪烁） |
| 神经元 | 斐波那契球节点 + 3 近邻连线，**按深度 4 档 × 光照 3 档**批量填充，左上前方打光 |
| 记忆光点 | 每条记忆一颗：外晕 + 亮核 + 细环，按类型配色、按重要度定大小、按年龄褪光 |
| 越球数据弧 | 沿大圆从节点 A 飞到节点 B 的弧线，头部是亮点，工具调用时必发 |
| 火花 | 沿连线滑动的彗星，带短线拖尾 |
| 同心倾斜环 | 两圈带刻度的椭圆轨道，反向缓慢旋转，其中大刻度更亮 |
| 准星括弧 | 球体四角的弧形括弧 + 端点，HUD 味道 |
| 水平扫描带 | 从上往下慢慢扫过球面的光带（只在有活动时出现） |
| 冲击波 | 工具调用时从球心外扩的琥珀色圆环 |
| 泛光 bloom | 四分之一分辨率的亮部提取 + 模糊 + 加法合成，让亮点真的"发光" |

HUD 首行是 `JARVIS · ACTIVE/STANDBY · N MEM · N TOOLS · N TURNS`；没有工具在跑时第二行报记忆库存
（`MEMORY  2 USER · 11 WORKING · 2 SPACES · 58 DOCS`）。

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
        personaText: ''    # 覆盖内置人设正文
        memoryDirs: []     # 额外探的记忆根目录，默认取 dsh-mnemon 的 dataDir
        maxMemoryNodes: 120  # 球面记忆光点上限 0–500
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
node test/host-smoke.mjs    # 22/22  工具计数、收尾、轮次、405、卸载清路由
node test/reload-smoke.mjs  # 15/15  路由生命周期：停用释放、重启用、旧路由占位、备用路径
node test/memory-smoke.mjs  # 14/14  记忆投影（只下发 hash/类型/重要度）+ 人格 section 注册与释放
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
- 记忆光点按 3 秒粒度重读存储根，刚写入的记忆最多慢 3 秒才亮。
- 人格是**提示文本**，不是权限或能力：它改语气与工作习惯，不改工具、不覆盖用户指令。
- 泛光依赖 `ctx.filter`；不支持的环境会自动跳过（不会糊成一片白）。
- 球体按窗口居中定位（用 `offsetX` 微调），不感知侧栏宽度变化。
- HUD 文字绘制在 canvas 上，是水印性质，不参与界面缩放与本地化。
- 实测渲染开销：单核约 5%（整机 0.3%）；记忆光点上限 120 颗，超出的不画。

## License

MIT
