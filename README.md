# dsh-jarvis-sphere

贾维斯式的球形神经元背景，长在 DeepSeek Harness Web 界面的整帧浮层里，**由当前任务的真实执行数据驱动**：Agent 有没有在跑、模型流式输出多快、刚刚调用了哪个工具。整层穿透点击，不影响任何操作。

![preview](docs/preview.png)

## 一眼看懂

- **待机**：球慢慢自转，暗青色，几乎不动。
- **思考 / 输出**：转速和亮度跟上模型流式速率，连线上的脉冲变密。
- **调工具**：每一次工具调用炸出一圈琥珀色冲击波，同时亮起点火花。
- **球心是空的**：聊天正文正好落在球心，光效不压字。

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
| `agent/assistant-stream` | 2.5 秒滑窗内的帧率 → 脉冲密度、转速 |
| `session/event` · `tool/call` | 工具调用 → 冲击波、火花、HUD 工具名 |
| `session/event` · `tool/result` | 收尾活动中的工具 |
| `session/event` · `turn/end` · `assistant/message` | 轮次 / 消息计数 |
| `subagent/start`、`agent/error` | 子代理数、错误计数 |

Client 半边（`client.js`）注册进 `shell.overlay` 槽位，用 Canvas 2D 绘制：460 个斐波那契球节点 + 3 近邻连线，按深度分档批量描边（每帧约 7 次 draw，而不是 1800 次）。不读 DOM、不改主题、不写会话日志。

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
        showHud: true      # 球下方状态文字
        color: cyan        # cyan | blue | green | amber | violet
        offsetX: 0         # 球心相对窗口中心的偏移
        offsetY: 0
```

改完在插件页重启该 bundle（或重启 DSH）。

## 验收

- 空闲：球在转、颜色偏暗、HUD 显示 `STANDBY`。
- 让它做一件事（比如跑一条命令）：球变亮变快、显示 `ACTIVE`，工具调用时出现琥珀冲击波，HUD 短暂显示工具名。
- 聊天正文照常可读、可点、可选中。

Host 半边的单元断言（工具计数、收尾、轮次、405、卸载清路由，共 22 条）：

```bash
node test/host-smoke.mjs
```

## 已知限制

- 数据是 140–450ms 粒度的轮询快照，不是逐 token 推送；视觉上够用，但不是严格实时。
- 球体按窗口居中定位（用 `offsetX` 微调），不感知侧栏宽度变化。
- HUD 文字绘制在 canvas 上，是水印性质，不参与界面缩放与本地化。
- 实测渲染开销：单核约 5%（整机 0.33%）。

## License

MIT
