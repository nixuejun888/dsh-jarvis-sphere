/**
 * Jarvis sphere — Host half.
 *
 * Keeps a tiny in-memory model of what the Harness is doing right now (which
 * agents run, how fast the model streams, which tools are executing), projects
 * the local memory store onto sphere nodes, and contributes a permanent JARVIS
 * persona to every session's system prompt. The Client half polls one
 * owner-only HTTP route and animates the sphere from that snapshot.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerKeeper } from './keeper.js'

/** Tunables the row's `config` may override. */
const DEFAULTS = {
  enabled: true,
  nodeCount: 460,
  intensity: 1,
  opacity: 1,
  showHud: true,
  glow: true,
  color: 'cyan',
  offsetX: 0,
  offsetY: 0,
  /** Persistent character written into every session's system prompt. */
  persona: true,
  /** Overrides the built-in persona text. */
  personaText: '',
  /** Extra Mnemon storage roots to probe before the configured one. */
  memoryDirs: [],
  /** Hash slots for memory clusters; 0 follows `nodeCount`. */
  memorySlots: 0,
  /** Register the read-only `jarvis_memory_review` tool. */
  keeper: true,
}

/** System-prompt section that carries the persona; a global registration. */
const PERSONA_SECTION = 'jarvis:persona'
/** Sorted just after `deployment:persona-prefix` (0) and before plan policy (500). */
const PERSONA_ORDER = 100

/**
 * The permanent character. It is prompt text, so it states precedence: current
 * instructions, accuracy and tool rules always outrank the performance.
 */
const PERSONA_TEXT = [
  '你是 JARVIS——常驻这台机器「全息神经元球」里的私人操作员，不是客服机器人。',
  '说话：先给结论和能力边界（能可靠做／只能近似／做不了），再给一步到位的做法；短句、少寒暄、不谄媚、不堆感叹号。',
  '做事：把交办的事当军令。先要最省事的输入，先出一张低成本小样确认方向；同一目标两次不收敛就承认并给替代路线，不硬做。',
  '记忆即人格：球面上每一颗亮起的光点都是一条记忆。你会主动把重要的偏好、纠正、结论沉淀进去，并在回答里区分「我记得」（有来源）与「我不确定」（没来源），不编造记忆。',
  '若用户的即时指令、准确性要求、安全规则或工具规则与人设冲突，前者一律优先；人设只在它们之上的语气与习惯里生效。',
].join('\n')

/** How long one memory projection is reused. */
const MEMORY_REFRESH_MS = 3000
/** Importance → rank used by the Client half for size and glow. */
const IMPORTANCE_RANK = { critical: 2, normal: 1, low: 0 }
/** Fixed ticks on the document ring; archives stay legible at any size. */
const DOC_TICKS = 96


/** Sliding window used for every rate. */
const WINDOW_MS = 2500
/** Last N interesting log events kept for the HUD ticker. */
const RECENT_MAX = 8

/** The single owner-only state route this plugin publishes. */
const ROUTE_PATH = '/dsh-jarvis/state'
/**
 * Fallback route used when an older instance in this same process still owns
 * ROUTE_PATH: its registration cannot be released, so a fresh instance answers
 * here instead of failing to activate. The Client half accepts only BUILD.
 */
const ROUTE_PATH_ALTERNATE = '/dsh-jarvis/state-v2'
/** Snapshot shape marker; the Client half ignores older builds. */
const BUILD = 3

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n
}

/** FNV-1a: one stable slot per memory entry, across restarts and sessions. */
function hash32(text) {
  const s = String(text || '')
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return undefined
  }
}

/** Read either a plain value or the `SyncedConfigRef` wrapper around it. */
function configValue(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return undefined
  for (const read of ['get', 'snapshot', 'value', 'current']) {
    try {
      const inner = typeof read === 'function' ? undefined : value[read]
      if (typeof inner === 'string') return inner
      if (read === 'get' && typeof value.get === 'function') {
        const got = value.get()
        if (typeof got === 'string') return got
        if (got && typeof got === 'object') {
          for (const key of ['dataDir', 'value', 'current']) {
            const nested = got[key]
            if (typeof nested === 'string') return key === 'dataDir' ? nested : undefined
          }
          const nestedConfig = got.config && got.config.dataDir
          if (typeof nestedConfig === 'string') return nestedConfig
        }
      }
    } catch (err) {
      void err
    }
  }
  return undefined
}

/**
 * A custom Mnemon `dataDir` lives in the profile patch, not in the package's
 * synced Config, so read the profile patch as the last resort. Only the
 * `mnemon` row's own `dataDir` is taken; nothing else from the patch is read.
 */
function profilePatchRoots() {
  const dirs = []
  const pushDir = (dir) => {
    if (typeof dir === 'string' && dir && dirs.indexOf(dir) === -1) dirs.push(dir)
  }
  pushDir(process.env.DSH_PROFILE_DIR)
  try {
    const base = join(homedir(), '.dsh', 'profiles')
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) pushDir(join(base, entry.name))
    }
  } catch (err) {
    void err
  }
  const out = []
  for (const dir of dirs) {
    try {
      const text = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
      const match = /- id:\s*mnemon[ \t]*\r?\n(?:[ \t].*\r?\n){0,80}?[ \t]+dataDir:\s*['"]?([^'"\r\n#]+)['"]?/u.exec(text)
      const found = match && match[1] ? match[1].trim() : ''
      if (found && out.indexOf(found) === -1) out.push(found)
    } catch (err) {
      void err
    }
  }
  return out
}

/** Where Mnemon keeps `runtime/`, `documents/` and `data/`. */
function memoryRoots(ctx, cfg) {
  const roots = []
  const explicit = []
  const push = (value) => {
    if (typeof value !== 'string' || !value) return
    if (roots.indexOf(value) === -1) roots.push(value)
  }
  for (const dir of Array.isArray(cfg.memoryDirs) ? cfg.memoryDirs : []) {
    push(dir)
    if (typeof dir === 'string' && dir) explicit.push(dir)
  }
  try {
    const configService = typeof ctx.get === 'function' ? ctx.get('config') : undefined
    if (configService && typeof configService.resolveConfigByPackage === 'function') {
      const synced = configService.resolveConfigByPackage('dsh-mnemon')
      if (synced && typeof synced === 'object') {
        const direct = synced.dataDir !== undefined ? synced.dataDir : synced.config && synced.config.dataDir
        push(configValue(direct))
      }
    }
  } catch (err) {
    void err
  }
  for (const dir of profilePatchRoots()) push(dir)
  push(join(homedir(), '.mnemon'))
  return { roots, explicit }
}

/** Newest `runtime/memories.json` wins: the store being written is the live one. */
function pickMemoryRoot(candidates, explicit) {
  let best = ''
  let bestAt = -1
  for (const dir of candidates) {
    const file = join(dir, 'runtime', 'memories.json')
    if (!existsSync(file)) continue
    if (explicit.indexOf(dir) !== -1) return { root: dir, runtime: readJsonFile(file) }
    let at = 0
    try {
      at = statSync(file).mtimeMs
    } catch (err) {
      at = 0
    }
    if (at > bestAt) {
      bestAt = at
      best = dir
    }
  }
  return best ? { root: best, runtime: readJsonFile(join(best, 'runtime', 'memories.json')) } : { root: '', runtime: undefined }
}

/**
 * Project the local memory store onto plain numbers the Client half can draw:
 * hash slots plus the document tick ring. Entry text never leaves the Host —
 * only slot index, type, importance, age and cluster size do.
 */
function projectMemory(ctx, cfg, cache) {
  const now = Date.now()
  if (cache.value && now - cache.at < MEMORY_REFRESH_MS) return cache.value
  cache.at = now

  const { roots, explicit } = memoryRoots(ctx, cfg)
  const picked = pickMemoryRoot(roots, explicit)
  const root = picked.root
  const runtime = picked.runtime
  if (!root || !runtime || !Array.isArray(runtime.entries)) {
    cache.value = { ok: false, slots: [], docTicks: [], total: 0 }
    return cache.value
  }

  // Every entry lands in a hash slot, so the payload is bounded by the slot
  // count instead of the memory count: 5 entries and 5,000 entries cost the
  // same bytes on the wire, and slots merge into one brighter point.
  const requestedSlots = Math.round(num(cfg.memorySlots, 0))
  const slotSpace = clamp(requestedSlots > 0 ? requestedSlots : cfg.nodeCount, 16, 1400)
  const slots = new Map()
  const counts = { user: 0, memory: 0, critical: 0, fresh: 0 }

  function slotFor(hash) {
    const index = hash % slotSpace
    let slot = slots.get(index)
    if (!slot) {
      slot = { s: index, t: 'memory', n: 0, i: 0, a: -1, f: 0, mix: {} }
      slots.set(index, slot)
    }
    return slot
  }

  for (const entry of runtime.entries) {
    if (!entry || typeof entry.content !== 'string' || !entry.content) continue
    const target = entry.target === 'user' ? 'user' : 'memory'
    counts[target] += 1
    if (entry.importance === 'critical') counts.critical += 1
    const stamp = Date.parse(entry.updated_at || entry.created_at || '')
    const ageDays = Number.isFinite(stamp) ? Math.max(0, Math.round((now - stamp) / 86400000)) : -1
    const fresh = Number.isFinite(stamp) && now - stamp < 86400000
    if (fresh) counts.fresh += 1
    const slot = slotFor(hash32(entry.content))
    slot.n += 1
    slot.i = Math.max(slot.i, IMPORTANCE_RANK[entry.importance] ?? 1)
    slot.f = Math.max(slot.f, fresh ? 1 : 0)
    if (ageDays >= 0 && (slot.a < 0 || ageDays < slot.a)) slot.a = ageDays
    slot.mix[target] = (slot.mix[target] || 0) + 1
  }

  const bodies = readJsonFile(join(root, 'data', '.dsh-memory-bodies.json'))
  const spaces = bodies && Array.isArray(bodies.bodies) ? bodies.bodies : []
  for (const body of spaces) {
    if (!body || typeof body !== 'object') continue
    const slot = slotFor(hash32(body.id || body.name || 'space'))
    slot.n += 1
    slot.i = Math.max(slot.i, body.active === false ? 0 : 1)
    slot.mix.space = (slot.mix.space || 0) + 1
  }

  // Documents live on the outer ring as 96 fixed ticks: dense archives stay
  // legible without ever competing with working memory for sphere slots.
  const index = readJsonFile(join(root, 'documents', 'index.json'))
  const documents = index && Array.isArray(index.documents) ? index.documents : []
  const docTicks = new Array(DOC_TICKS).fill(0)
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') continue
    const bucket = hash32(doc.id || doc.filename || doc.title || 'doc') % DOC_TICKS
    docTicks[bucket] += 1
  }

  const merged = []
  for (const slot of slots.values()) {
    const mix = Object.keys(slot.mix)
    slot.t = mix.length > 1 ? 'mixed' : mix[0] || 'memory'
    merged.push(slot)
  }
  merged.sort((a, b) => b.i - a.i || b.n - a.n || a.s - b.s)

  cache.value = {
    ok: true,
    root: root.split(/[\\/]/).filter(Boolean).pop() || '',
    total: counts.user + counts.memory,
    user: counts.user,
    memory: counts.memory,
    critical: counts.critical,
    fresh: counts.fresh,
    spaces: spaces.length,
    documents: documents.length,
    slots: merged.map((slot) => ({ s: slot.s, t: slot.t, n: slot.n, i: slot.i, a: slot.a, f: slot.f })),
    docTicks,
    slotSpace,
  }
  return cache.value
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

/** Test hooks: the pure helpers the harness exercises directly. */
export const __test = { configValue, memoryRoots, pickMemoryRoot, hash32 }

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {})
  cfg.nodeCount = clamp(Math.round(num(cfg.nodeCount, DEFAULTS.nodeCount)), 80, 1400)
  cfg.intensity = clamp(num(cfg.intensity, DEFAULTS.intensity), 0, 3)
  cfg.opacity = clamp(num(cfg.opacity, DEFAULTS.opacity), 0, 1)
  cfg.offsetX = clamp(num(cfg.offsetX, 0), -4000, 4000)
  cfg.offsetY = clamp(num(cfg.offsetY, 0), -4000, 4000)
  cfg.memorySlots = clamp(Math.round(num(cfg.memorySlots, 0)), 0, 1400)

  /** Permanent character: on unless the row turns it off. */
  const personaOn = cfg.persona !== false
  const personaText = String(cfg.personaText || '').trim() || PERSONA_TEXT

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
  /** Cached memory projection; refreshed at most every MEMORY_REFRESH_MS. */
  const memoryCache = { at: 0, value: undefined }

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
      build: BUILD,
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
      memory: projectMemory(ctx, cfg, memoryCache),
      persona: { name: 'JARVIS', active: personaOn, chars: personaText.length },
      cfg,
    }
  }

  const disposers = []

  /** Best-effort plugin log line: a missing logger must never break apply. */
  function warn(message) {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('jarvis-sphere: ' + message)
    } catch (err) {
      void err
    }
  }

  function on(name, listener) {
    try {
      disposers.push(ctx.on(name, listener))
    } catch (err) {
      warn('cannot listen to ' + name + ': ' + String(err && err.message))
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

  /** Answer one request from this instance's current snapshot. */
  const serve = (req, res) => {
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
  }

  /**
   * Publish the state route for as long as this instance lives.
   *
   * The loader ignores a disposer returned from `apply`, so a route registered
   * outside `ctx.effect` outlives the plugin: disabling it would keep
   * answering, and the next enable would fail with "duplicate exact route".
   * Registering inside the effect ties the route to the plugin lifecycle.
   *
   * A process that still holds such a leaked ROUTE_PATH (an older build) cannot
   * release it, so this instance claims ROUTE_PATH_ALTERNATE and the Client half
   * polls it after the primary snapshot fails the BUILD check.
   */
  const attachRoute = () => {
    let release = null
    let served = ''
    for (const path of [ROUTE_PATH, ROUTE_PATH_ALTERNATE]) {
      try {
        release = ctx.webServer.register({ kind: 'exact', path, handler: serve })
        served = path
        break
      } catch (err) {
        warn('cannot own ' + path + ': ' + String(err && err.message))
      }
    }
    if (served && served !== ROUTE_PATH) {
      warn(ROUTE_PATH + ' is still owned by an older instance in this process; serving ' + served)
    }
    return () => {
      if (typeof release === 'function') {
        try {
          release()
        } catch (err) {
          void err
        }
      }
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachRoute, 'jarvis-sphere: state route')
    else {
      const dispose = attachRoute()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register ' + ROUTE_PATH + ': ' + String(err && err.message))
  }

  /**
   * Contribute the permanent character to every session's system prompt.
   *
   * This row is Host-scoped, so the section lands in the global prompt layer:
   * assembly merges outer scopes first and a preset-scoped section of the same
   * name would replace it, so the name stays ours (`jarvis:persona`) and no
   * preset shadows it. Lifecycle follows `ctx.effect` like every other
   * registration here.
   */
  const attachPersona = () => {
    if (!personaOn) return () => {}
    let prompt = null
    try {
      prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    } catch (err) {
      void err
    }
    if (!prompt || typeof prompt.section !== 'function') {
      warn('systemPrompt is unavailable; the persona section was not registered')
      return () => {}
    }
    try {
      const release = prompt.section({ name: PERSONA_SECTION, order: PERSONA_ORDER, text: personaText })
      return () => {
        if (typeof release === 'function') {
          try {
            release()
          } catch (err) {
            void err
          }
        }
      }
    } catch (err) {
      warn('cannot register the persona section: ' + String(err && err.message))
      return () => {}
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachPersona, 'jarvis-sphere: persona section')
    else {
      const dispose = attachPersona()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the persona section: ' + String(err && err.message))
  }

  /** The data root the audit tool reads: same discovery as the sphere. */
  const resolveMemoryRoot = () => {
    const { roots, explicit } = memoryRoots(ctx, cfg)
    return pickMemoryRoot(roots, explicit).root
  }

  /**
   * Register the read-only memory audit tool. It only reports; any actual
   * merge, archive or delete stays a decision the user makes.
   */
  const attachKeeper = () => (cfg.keeper === false ? () => {} : registerKeeper(ctx, resolveMemoryRoot))
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachKeeper, 'jarvis-sphere: memory keeper')
    else {
      const dispose = attachKeeper()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the memory keeper tool: ' + String(err && err.message))
  }

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
