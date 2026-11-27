# 贾维斯全息神经元球

![A holographic neuron sphere behind the chat](preview.png)

在 Web 界面背景里铺一层会呼吸的全息神经元球：经纬线球壳、神经元节点与连线、越球数据弧、同心倾斜刻度环、准星括弧、扫描带、冲击波，最后统一过一遍泛光。

**它是真的被任务数据驱动的**，不是纯装饰动画：

| 视觉 | 数据来源 |
| --- | --- |
| 球体转速、整体亮度、呼吸幅度 | 当前是否有 Agent 在跑（`agent/status`，或由真实活动推断） |
| 脉冲密度、能量亮度、底部环形表 | 模型流式输出的速率（`agent/assistant-stream` 帧频） |
| 琥珀色冲击波 + 越球数据弧 + 火花 | 每一次工具调用（会话日志里的 `tool/call`） |
| 球下方 HUD 文字 | 运行状态、累计工具数、轮次数；工具执行期间额外显示工具名 |
| 子代理计数 | `subagent/start` |

## 行为

- 整层 `pointer-events: none`，穿透点击，不遮挡、不抢焦点。
- 球心做了「挖空」处理：中间是暗的，聊天正文正好落在球心，读起来不受影响。
- 深色主题用 `mix-blend-mode: screen` 发光，浅色主题自动切成 `multiply` 深青，跟随主题令牌 `--dsw-alias-bg-base` 自行切换。
- 泛光用四分之一分辨率的亮部提取 + 模糊 + 加法合成；运行环境不支持 `ctx.filter` 时自动跳过（不会糊成一片白）。
- 标签页隐藏（`document.hidden`）时停帧，不空转。
- 空闲时降频轮询（450ms），运行中升到 140ms。

## 配置

在 `cordis.patch.yml` 的这一行改 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉整个浮层 |
| `nodeCount` | `460` | 节点数，80–1400；越高越密 |
| `intensity` | `1` | 能量强度倍率，0–3 |
| `opacity` | `1` | 整体不透明度，0–1 |
| `showHud` | `true` | 球下方状态文字 + 底部环形表 |
| `glow` | `true` | 泛光开关，关掉更省也更素 |
| `color` | `cyan` | `cyan` / `blue` / `green` / `amber` / `violet` |
| `offsetX` / `offsetY` | `0` | 球心相对窗口中心的偏移（像素） |

## 实现

- Host 半边只做一件事：把 `agent/status`、`agent/assistant-stream`、`session/event`（`tool/call`、`tool/result`、`turn/end`、`assistant/message`）和 `subagent/start` 折进一个约 1.8–2 KB 的快照（空闲典型值，槽位封顶），挂在 owner-only 的 `GET /dsh-jarvis/state` 上。
- Client 半边注册进 `shell.overlay` 槽位，用 Canvas 2D 画球；节点按深度 4 档 × 光照 3 档批量填充，连线按深度 3 档批量描边。
- 不写会话日志、不改任何配置、不碰别的插件的 DOM。

## 参考

- 泛光做法：[Cheap bloom for a Canvas 2D game in 8 lines](https://dev.to/nightdrivelabs/cheap-bloom-for-a-canvas-2d-game-in-8-lines-no-webgl-4jah)
- 构图思路：[JARVIS HUD 里元素贴在包围观察者的透明球面上、同心底层排布并带倾角](https://uxdaystokyo.com/articles/vertical_surface_corners/)

## 已知限制

- 数据是 140–450ms 粒度的轮询快照，不是逐 token 推送；视觉上够用，但不是严格实时。
- 球体按窗口居中定位（可用 `offsetX` 微调），不感知侧栏宽度变化。
- HUD 文字是绘制在 canvas 上的水印，不参与界面缩放与本地化。
