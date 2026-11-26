/**
 * Jarvis sphere — Host half.
 *
 * Keeps a tiny in-memory model of what the Harness is doing right now (which
 * agents run, how fast the model streams, which tools are executing) and
 * publishes it on one owner-only HTTP route. The Client half polls that route
 * and animates a neuron sphere from it. Nothing here reaches a model request.
 */

/** Tunables the row's `config` may override. */
const DEFAULTS = {
  enabled: true,
  nodeCount: 460,
  intensity: 1,
  opacity: 1,
  showHud: true,
  color: 'cyan',
  offsetX: 0,
  offsetY: 0,
}

/** Sliding window used for every rate. */
const WINDOW_MS = 2500
/** Last N interesting log events kept for the HUD ticker. */
const RECENT_MAX = 8

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n
}

/** Best-effort: the SessionId an Agent speaks for. */
function sessionIdOf(agent) {
  if (!agent || typeof agent !== 'object') return ''
  const session = agent.session
  if (session && session.id) return String(session.id)
  if (agent.sessionId) return String(agent.sessionId)
  if (agent.id) return String(agent.id)
  return ''
}

/** Best-effort: the tool name inside a `tool/call` record. */
function toolNameOf(data) {
  if (!data || typeof data !== 'object') return ''
  const direct = data.name || data.tool || data.toolName || data.toolId
  if (typeof direct === 'string' && direct) return direct
  const nested = [data.call, data.block, data.invocation, data.request]
  for (const inner of nested) {
    if (!inner || typeof inner !== 'object') continue
    const n = inner.name || inner.tool || inner.toolName
    if (typeof n === 'string' && n) return n
  }
  // Last resort: a tool-call content block inside the recorded message.
  const content = data.message && data.message.content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool-call' || block.type === 'tool_call' || block.type === 'toolUse') {
        const n = block.name || block.toolName
        if (typeof n === 'string' && n) return n
      }
    }
  }
  return ''
}

function callIdOf(data) {
  if (!data || typeof data !== 'object') return ''
  const id = data.callId || data.id || data.toolCallId
  if (typeof id === 'string' && id) return id
  const inner = data.call
  if (inner && typeof inner === 'object' && typeof inner.id === 'string') return inner.id
  return ''
}

export const inject = ['webServer']

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  cfg.nodeCount = clamp(Math.round(num(cfg.nodeCount, DEFAULTS.nodeCount)), 80, 1400)
  cfg.intensity = clamp(num(cfg.intensity, DEFAULTS.intensity), 0, 3)
  cfg.opacity = clamp(num(cfg.opacity, DEFAULTS.opacity), 0, 1)
  cfg.offsetX = clamp(num(cfg.offsetX, 0), -4000, 4000)
  cfg.offsetY = clamp(num(cfg.offsetY, 0), -4000, 4000)

  /** sessionId -> 'running' | 'idle' */
  const statuses = new Map()
  /** timestamps of assistant stream frames */
  const streamAt = []
  /** timestamps of tool calls */
  const toolAt = []
  /** callId -> { name, at } */
  const activeTools = new Map()
  const counters = {
    tools: 0,
    turns: 0,
    messages: 0,
    userMessages: 0,
    subagents: 0,
    errors: 0,
  }
  const recent = []
  let lastToolName = ''
  let lastToolAt = 0
  let lastActivityAt = 0

  /** 任何真实活动（流式帧、工具调用、会话追加）都刷新一次活跃时间。 */
  function touch() {
    lastActivityAt = Date.now()
  }

  function prune(list, now) {
    const floor = now - WINDOW_MS
    let drop = 0
    while (drop < list.length && list[drop] < floor) drop++
    if (drop > 0) list.splice(0, drop)
  }

  function note(kind, label) {
    recent.push({ k: kind, l: label, at: Date.now() })
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX)
  }

  function onToolCall(data) {
    const now = Date.now()
    touch()
    const name = toolNameOf(data) || 'tool'
    const id = callIdOf(data) || 'call-' + now + '-' + Math.random().toString(36).slice(2, 7)
    toolAt.push(now)
    counters.tools += 1
    lastToolName = name
    lastToolAt = now
    activeTools.set(id, { name, at: now })
    note('tool', name)
  }

  function onToolResult(data) {
    const id = callIdOf(data)
    if (id && activeTools.has(id)) activeTools.delete(id)
    else if (activeTools.size > 0) {
      // No usable id: retire the oldest, which is the one most likely settled.
      const oldest = activeTools.keys().next()
      if (!oldest.done) activeTools.delete(oldest.value)
    }
  }

  function handleSessionEvent(event) {
    const type = event && event.type
    if (typeof type !== 'string' || !type) return
    const data = event && event.data && typeof event.data === 'object' ? event.data : {}
    if (type === 'tool/call') onToolCall(data)
    else if (type === 'tool/result') onToolResult(data)
    else if (type === 'turn/end') {
      counters.turns += 1
      note('turn', '')
    } else if (type === 'assistant/message') {
      counters.messages += 1
      note('message', '')
    } else if (type === 'user/message') {
      counters.userMessages += 1
      note('user', '')
    } else if (type === 'turn/error' || type === 'error') {
      counters.errors += 1
      note('error', '')
    }
  }

  function snapshot() {
    const now = Date.now()
    prune(streamAt, now)
    prune(toolAt, now)
    let running = 0
    for (const status of statuses.values()) if (status === 'running') running += 1
    const seconds = WINDOW_MS / 1000
    const active = []
    for (const entry of activeTools.values()) active.push(entry.name)
    // 根上下文未必收得到 scoped 的 agent/status；用真实活动补齐运行态。
    const activeRecently = lastActivityAt > 0 && now - lastActivityAt < 3000
    return {
      v: 1,
      build: 2,
      ts: now,
      running: running > 0 || activeRecently,
      agents: running,
      streamRate: Math.round((streamAt.length / seconds) * 10) / 10,
      toolRate: Math.round((toolAt.length / seconds) * 10) / 10,
      activeTools: active.slice(-4),
      lastTool: lastToolName,
      sinceTool: lastToolAt ? now - lastToolAt : -1,
      pulse: lastToolAt ? Math.max(0, 1 - (now - lastToolAt) / 1200) : 0,
      counters: Object.assign({}, counters),
      recent: recent.slice(-6).map((r) => ({ k: r.k, l: r.l })),
      cfg,
    }
  }

  const disposers = []

  function on(name, listener) {
    try {
      disposers.push(ctx.on(name, listener))
    } catch (err) {
      ctx.logger ? ctx.logger.warn('jarvis-sphere: cannot listen to ' + name + ': ' + String(err && err.message)) : void 0
    }
  }

  on('agent/status', (payload) => {
    const agent = payload && payload.agent
    const id = sessionIdOf(agent) || 'agent'
    const status = payload && payload.status
    if (typeof status === 'string' && status) statuses.set(id, status)
  })

  on('agent/disposed', (payload) => {
    const id = sessionIdOf(payload && payload.agent)
    if (id) statuses.delete(id)
  })

  on('agent/assistant-stream', () => {
    streamAt.push(Date.now())
    touch()
  })

  on('session/event', (session, event) => {
    void session
    touch()
    handleSessionEvent(event)
  })

  on('subagent/start', () => {
    counters.subagents += 1
  })

  on('agent/error', () => {
    counters.errors += 1
  })

  // Seed the running state so a page loaded mid-turn is active immediately.
  try {
    const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
    for (const agent of agents) {
      const id = sessionIdOf(agent)
      const status = agent && (agent.status || agent.state)
      if (id && (status === 'running' || status === 'idle')) statuses.set(id, status)
    }
  } catch (err) {
    void err
  }

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-jarvis/state',
      handler: (req, res) => {
        try {
          if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
            res.statusCode = 405
            res.setHeader('allow', 'GET, HEAD')
            res.end()
            return
          }
          const body = JSON.stringify(snapshot())
          res.statusCode = 200
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('content-length', Buffer.byteLength(body))
          res.end(req.method === 'HEAD' ? undefined : body)
        } catch (err) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (err) {
        void err
      }
    }
    disposers.length = 0
    statuses.clear()
    activeTools.clear()
  }
}
