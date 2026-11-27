/**
 * Jarvis sphere — Host half.
 *
 * Keeps a tiny in-memory model of what the Harness is doing right now (which
 * agents run, how fast the model streams, which tools are executing), projects
 * the local memory store onto sphere nodes, and contributes a permanent JARVIS
 * persona to every session's system prompt. The Client half polls one
 * owner-only HTTP route and animates the sphere from that snapshot.
 */

import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerKeeper } from './keeper.js'
import { backupStatus, collectSources, createBackup, restorePlan, verifyBackup } from './backup.js'

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
  /** Write a daily chronicle line on every turn end. */
  chronicle: true,
  /** Chronicle directory; empty uses `~/.dsh/jarvis-sphere`. */
  chronicleDir: '',
  /** One-command archive of memory, chronicle, persona and config. */
  backup: true,
  /** Archive directory; empty uses ~/.dsh/jarvis-sphere/backups. */
  backupDir: '',
  /** Archives kept before the oldest is pruned. */
  backupKeep: 7,
  /** Proactive alerts as runtime prompt context. */
  alerts: true,
}

/** Chronicle file name inside the chronicle directory. */
const CHRONICLE_FILE = 'chronicle.jsonl'
/** Rotate the chronicle once it grows past this size (synchronous, rare). */
const CHRONICLE_MAX_BYTES = 512 * 1024
/** Lines kept when rotating. */
const CHRONICLE_KEEP_LINES = 2000
/** Runtime context name for proactive alerts. */
const ALERT_CONTEXT = 'jarvis:alerts'
/** Alerts are appended late so the persona reads first. */
const ALERT_CONTEXT_ORDER = 810
/** How many alerts one step may carry before the rest wait. */
const ALERT_CONTEXT_MAX = 4

/** Characters of the user message kept as the chronicle label. */
const CHRONICLE_LABEL_MAX = 80

/** Local calendar day key, e.g. 2026-11-27. */
function dayKey(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/** Local YYYY-MM-DD HH:mm for a stored ISO timestamp; empty when unparsable. */
function localStamp(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return dayKey(d.getTime()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** One flat, clipped label; control characters never reach the file or a render. */
function clipLabel(text) {
  const flat = String(text || '')
    .replace(/\s+/gu, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .trim()
  /* Truncate by code point so a surrogate pair is never split. */
  return Array.from(flat).slice(0, CHRONICLE_LABEL_MAX).join('')
}

/** Last `keep` non-empty lines of a file, or [] when it is missing. */
function readTailLines(file, keep) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim())
    return keep > 0 ? lines.slice(-keep) : lines
  } catch (err) {
    return []
  }
}

/**
 * Keep only the newest lines that fit `budgetBytes` (and `limit` lines), so a
 * rotation is bounded by bytes rather than by a line count alone.
 */
function keepNewestByBytes(lines, budgetBytes, limit) {
  const kept = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (kept.length >= limit) break
    if (bytes + size > budgetBytes && kept.length > 0) break
    bytes += size
    kept.push(line)
  }
  return kept.reverse()
}

/** Harness-injected text blocks are context, not something the user said. */
const INJECTED_LABEL = /^(<system-reminder>|Time sampled while preparing|\[MNEMON\]|MNEMON RUNTIME)/u

/**
 * The human's own words from a recorded user message, clipped. Injected
 * reminder blocks are skipped: the chronicle should read like a conversation
 * log, not like a dump of harness scaffolding.
 */
function messageTextOf(message) {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  let last = ''
  for (const block of content) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (!text || INJECTED_LABEL.test(text)) continue
    last = text
  }
  return last ? clipLabel(last) : ''
}


/** System-prompt section that carries the persona; a global registration. */
const PERSONA_SECTION = 'jarvis:persona'
/** Sorted just after `deployment:persona-prefix` (0) and before plan policy (500). */
const PERSONA_ORDER = 100

/** Package directory: persona.md next to this module is the default source. */
const HERE = dirname(fileURLToPath(import.meta.url))
/** Section default when neither personaFile nor personaText resolves. */
const PERSONA_FALLBACK = '你是 JARVIS——常驻这台机器「全息神经元球」里的私人操作员。'
/**
 * Read the persona text: config override, then an explicit personaFile, then
 * the package persona.md, then a one-line fallback. Every attempt reports
 * where the text came from plus the file it tried, so a packaging mistake that
 * silently drops the persona is visible in the snapshot and the log.
 */
function loadPersona(cfg) {
  const override = String(cfg.personaText || '').trim()
  if (override) return { text: override, source: 'config', file: '' }
  const explicit = String(cfg.personaFile || '').trim()
  const candidates = []
  if (explicit) candidates.push(explicit)
  candidates.push(join(HERE, 'persona.md'))
  let lastFile = ''
  for (const file of candidates) {
    lastFile = file
    try {
      /* Normalise line endings: a CRLF checkout must not change the revision tag. */
      const text = readFileSync(file, 'utf8').replace(/\r\n?/gu, '\n').trim()
      if (text) return { text, source: 'file', file }
    } catch (err) {
      void err
    }
  }
  return { text: PERSONA_FALLBACK, source: 'fallback', file: lastFile }
}/** How long one memory projection is reused. */
const MEMORY_REFRESH_MS = 3000
/** Importance → rank used by the Client half for size and glow. */
const IMPORTANCE_RANK = { critical: 2, normal: 1, low: 0 }
/** Hard cap for the per-instance event windows (stream frames, tool calls, errors). */
const WINDOW_MAX = 4096
const ERROR_MAX = 4096
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
  const persona = loadPersona(cfg)
  const personaText = persona.text
  if (persona.source === 'fallback') {
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('jarvis-sphere: persona fell back to one line; tried ' + String(persona.file || '') )
      }
    } catch (err) {
      void err
    }
  }
  /** Short revision tag of the live persona text, surfaced in the snapshot. */
  const personaVersion = hash32(personaText).toString(16).padStart(8, '0').slice(-8)
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
  /** Recent agent-error timestamps; bounded by ERROR_MAX. */
  const errorAt = []
  /** Cached memory projection; refreshed at most every MEMORY_REFRESH_MS. */
  const memoryCache = { at: 0, value: undefined }

  /**
   * Chronicle: one JSON line per finished turn, so a day can be replayed later.
   * It stores a clipped user label, never the assistant transcript, and the
   * file is rotated by size so years of use stay bounded.
   */
  const chronicleDir = String(cfg.chronicleDir || '').trim() || join(homedir(), '.dsh', 'jarvis-sphere')
  const chronicleFile = join(chronicleDir, CHRONICLE_FILE)
  /**
   * Per-session pending turn: a label and tool baseline belong to the session
   * that produced them, never to whichever session ends a turn first.
   */
  const chronicle = { pending: new Map(), days: new Map() }
  /** sessionId -> tool calls seen, so a turn's tools are that session's own. */
  const sessionTools = new Map()
  /** Cached self-check report; diagnostics do file and service probes. */
  const diagCache = { at: 0, value: undefined }
  /** What the plugin actually managed to register, for the self-check. */
  const registered = { route: 'none', persona: 'off', keeper: false, chronicleTool: false, doctor: false, backup: false, alerts: false, alertTool: false }

  /** Aggregate every line the file holds (bounded by the rotation budget). */
  function aggregateChronicle(lines) {
    const days = new Map()
    for (const line of lines) {
      for (const record of parseChronicleLine(line)) {
        const day = days.get(record.d) || { turns: 0, tools: 0 }
        day.turns += 1
        day.tools += Number(record.tools) || 0
        days.set(record.d, day)
      }
    }
    return days
  }

  /**
   * Load the whole (bounded) file once at apply, so a busy day's count survives
   * a restart exactly instead of being clipped to the last N lines.
   */
  function loadChronicle() {
    if (cfg.chronicle === false) return
    chronicle.days = aggregateChronicle(readTailLines(chronicleFile, 0))
  }
  loadChronicle()

/**
 * Parse one chronicle line. A writer that lost its trailing newline can glue
 * two records together; recover both instead of silently dropping the line.
 */
function parseChronicleLine(line) {
  const out = []
  const adopt = (text) => {
    try {
      const record = JSON.parse(text)
      if (record && typeof record.d === 'string') out.push(record)
    } catch (err) {
      void err
    }
  }
  adopt(line)
  if (out.length === 0 && line.includes('}{')) {
    let rest = line
    while (rest.length) {
      const at = rest.indexOf('}{')
      if (at < 0) {
        adopt(rest)
        break
      }
      adopt(rest.slice(0, at + 1))
      rest = rest.slice(at + 1)
    }
  }
  return out
}
  /** Append one finished turn; failures are reported but never fatal. */
  function recordTurn(sessionId, origin) {
    if (cfg.chronicle === false) return
    const key = String(sessionId || '')
    const pending = chronicle.pending.get(key)
    chronicle.pending.delete(key)
    /* A delegated child's turns are work, not "what we did today". */
    if (origin === 'subagent') return
    const now = Date.now()
    const day = dayKey(now)
    const tools = pending ? Math.max(0, (sessionTools.get(key) || 0) - pending.toolsAt) : 0
    const record = {
      t: new Date(now).toISOString(),
      d: day,
      s: key.slice(0, 12),
      u: pending ? pending.label : '',
      tools,
    }
    const dayCount = chronicle.days.get(day) || { turns: 0, tools: 0 }
    dayCount.turns += 1
    dayCount.tools += tools
    chronicle.days.set(day, dayCount)
    try {
      mkdirSync(chronicleDir, { recursive: true })
      appendFileSync(chronicleFile, JSON.stringify(record) + '\n')
      if (statSync(chronicleFile).size > CHRONICLE_MAX_BYTES) {
        const kept = keepNewestByBytes(
          readTailLines(chronicleFile, 0),
          Math.floor(CHRONICLE_MAX_BYTES * 0.8),
          CHRONICLE_KEEP_LINES,
        )
        const temp = chronicleFile + '.' + String(process.pid) + '.tmp'
        try {
          writeFileSync(temp, kept.join('\n') + '\n')
          renameSync(temp, chronicleFile)
        } finally {
          try {
            if (existsSync(temp)) unlinkSync(temp)
          } catch (err) {
            void err
          }
        }
      }
    } catch (err) {
      warn('chronicle write failed: ' + String(err && err.message))
    }
  }

  /**
   * Self-check: every subsystem the plugin depends on, as ok / degraded / fail.
   * It only reads; the doctor tool and the HUD both consume this one report.
   */
  function diagnose(force) {
    const now = Date.now()
    if (!force && diagCache.value && now - diagCache.at < 5000) return diagCache.value
    const checks = []
    const add = (id, status, detail) => checks.push({ id, status, detail })

    add('route', registered.route === 'none' ? 'fail' : registered.route === 'alternate' ? 'degraded' : 'ok',
      registered.route === 'none' ? 'state route is not registered' : registered.route === 'alternate' ? 'serving on the alternate path (an older instance owns the primary)' : 'serving ' + ROUTE_PATH)

    add('persona', !personaOn ? 'skip' : registered.persona === 'registered' ? 'ok' : 'degraded',
      !personaOn ? 'turned off by config' : registered.persona === 'registered' ? 'section ' + PERSONA_SECTION + ' v' + personaVersion : 'section not registered (systemPrompt unavailable?)')

    let memory = { ok: false }
    try {
      memory = projectMemory(ctx, cfg, memoryCache)
    } catch (err) {
      add('memory', 'fail', 'projection threw: ' + String(err && err.message))
    }
    if (memory && memory.ok) {
      add('memory', 'ok', (memory.total || 0) + ' entries · ' + Math.round((memory.documents || 0)) + ' docs · root ' + String(memory.root || '?'))
    } else if (!checks.some((check) => check.id === 'memory')) {
      add('memory', 'degraded', 'no Mnemon store found; the sphere renders without memory points')
    }

    if (typeof cfg.chronicle === 'boolean' && cfg.chronicle === false) {
      add('chronicle', 'skip', 'turned off by config')
    } else if (existsSync(chronicleDir)) {
      try {
        accessSync(chronicleDir, constants.W_OK)
        add('chronicle', 'ok', 'writable ' + chronicleDir)
      } catch (err) {
        add('chronicle', 'fail', 'cannot write ' + chronicleDir + ': ' + String(err && err.message))
      }
    } else {
      /* The poll path must not create directories: report readiness instead. */
      let ancestor = chronicleDir
      for (;;) {
        const parent = dirname(ancestor)
        if (!parent || parent === ancestor) break
        ancestor = parent
        if (existsSync(ancestor)) break
      }
      try {
        if (!statSync(ancestor).isDirectory()) {
          add('chronicle', 'fail', 'parent ' + ancestor + ' is a file, so the directory can never be created')
        } else {
          accessSync(ancestor, constants.W_OK)
          add('chronicle', 'degraded', 'not created yet; the first turn creates it under ' + ancestor)
        }
      } catch (err) {
        add('chronicle', 'fail', 'parent ' + ancestor + ' is not writable: ' + String(err && err.message))
      }
    }

    const services = ['agents', 'tokenMeter', 'schedule', 'tools', 'systemPrompt', 'webServer']
    const missing = []
    for (const name of services) {
      try {
        if (typeof ctx.get !== 'function' || !ctx.get(name)) missing.push(name)
      } catch (err) {
        missing.push(name)
      }
    }
    add('services', missing.length === 0 ? 'ok' : missing.length >= services.length ? 'fail' : 'degraded',
      missing.length === 0 ? 'all present' : 'missing: ' + missing.join(', '))

    const nowMs = Date.now()
    const stuckSchedule = scheduleCache.inflight && nowMs - scheduleCache.inflightAt > 10000
    const stalledRecently = scheduleCache.lastStuckAt > 0 && nowMs - scheduleCache.lastStuckAt < 60000
    add('caches', stuckSchedule || stalledRecently ? 'degraded' : 'ok',
      stuckSchedule
        ? 'schedule read stuck for more than 10 s'
        : stalledRecently
          ? 'a schedule read stalled and was retried ' + Math.round((nowMs - scheduleCache.lastStuckAt) / 1000) + 's ago'
          : 'memory ' + Math.round((nowMs - healthCache.at) / 1000) + 's · context ' + Math.round((nowMs - contextCache.at) / 1000) + 's ago')

    const toolWanted = [
      { name: 'keeper', ok: registered.keeper, disabled: cfg.keeper === false },
      { name: 'chronicle', ok: registered.chronicleTool, disabled: cfg.chronicle === false },
      { name: 'doctor', ok: registered.doctor, disabled: false },
      { name: 'backup', ok: registered.backup, disabled: cfg.backup === false },
      { name: 'alerts', ok: registered.alertTool && (registered.alerts || cfg.alerts === false), disabled: cfg.alerts === false },
    ]
    const toolMissing = toolWanted.filter((tool) => !tool.ok && !tool.disabled).map((tool) => tool.name)
    const toolStatus = toolMissing.length === 0 ? 'ok' : toolMissing.length === toolWanted.filter((tool) => !tool.disabled).length ? 'fail' : 'degraded'
    add('tools', toolStatus,
      toolWanted.map((tool) => tool.name + ' ' + (tool.ok ? 'on' : tool.disabled ? 'off' : 'missing')).join(' · '))

    if (cfg.backup === false) {
      add('backup', 'skip', 'turned off by config')
    } else {
      const status = backupReport()
      if (!status.latest) {
        add('backup', 'degraded', 'no archive yet under ' + backupDir + '; run jarvis_backup create')
      } else if (!status.ok) {
        add('backup', 'degraded', status.latest + ' is unreadable: ' + String(status.reason || 'unknown') + '; run jarvis_backup verify or create')
      } else if (status.ageDays > 14) {
        add('backup', 'degraded', 'newest archive is ' + status.ageDays + ' days old (' + status.latest + ')')
      } else if ((status.totals && status.totals.failed) || (status.totals && status.totals.truncated) || (status.truncated || []).length) {
        add('backup', 'degraded', 'newest archive is partial: ' + (status.totals.failed || 0) + ' failed, limits hit: ' + ((status.truncated || []).join('; ') || 'unknown') + '; consider raising the caps or creating another archive')
      } else if (status.ageDays < 0) {
        add('backup', 'degraded', status.latest + ' has an invalid createdAt; run jarvis_backup verify')
      } else {
        add('backup', 'ok', status.latest + ' · ' + (status.totals ? status.totals.files + ' files / ' + Math.round(status.totals.bytes / 1024) + ' KB' : 'no manifest') + ' · ' + status.ageDays + 'd old')
      }
    }
    const order = { fail: 2, degraded: 1, ok: 0, skip: -1 }
    let worst = 'ok'
    for (const check of checks) if (order[check.status] > order[worst]) worst = check.status
    diagCache.at = now
    diagCache.value = { status: worst, checks, at: new Date(now).toISOString() }
    return diagCache.value
  }
  /** Compact view for the snapshot and the tool: today plus recent days. */
  function chronicleSummary() {
    const today = dayKey(Date.now())
    const days = [...chronicle.days.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 7)
      .map(([day, value]) => ({ day, turns: value.turns, tools: value.tools }))
    const todayValue = chronicle.days.get(today) || { turns: 0, tools: 0 }
    return {
      todayTurns: todayValue.turns,
      todayTools: todayValue.tools,
      trackedDays: chronicle.days.size,
      days,
    }
  }

  /**
   * Proactive alerts: thresholds that turn into a runtime prompt context, so a
   * problem reaches the operator's next step instead of waiting to be noticed.
   * Each alert keeps a cooldown and can be acknowledged until its condition
   * clears, which keeps a standing problem from being repeated every step.
   */
  const ALERT_COOLDOWN_MS = 30 * 60 * 1000
  const alerts = { active: new Map(), acknowledged: new Set(), lastAt: new Map() }

  /** Current conditions worth telling the operator about. */
  function computeAlerts() {
    const out = []
    const now = Date.now()
    const memory = memoryHealth()
    const context = contextHealth()
    const schedules = scheduleHealth()
    const errors = recentErrors()

    if (Number(memory.memoryRatio) >= 0.9) {
      out.push({ id: 'memory', level: 'warn', text: '记忆库已用 ' + Math.round(Number(memory.memoryRatio) * 100) + '%，建议归档旧条目（jarvis_memory_review 看一眼）' })
    }
    if (Number(context.contextRatio) >= 0.85) {
      out.push({ id: 'context', level: 'warn', text: '上下文压力 ' + Math.round(Number(context.contextRatio) * 100) + '%，建议压缩或新开会话' })
    }
    if (Number(errors) >= 3) {
      out.push({ id: 'errors', level: 'warn', text: '最近 15 分钟内出现 ' + errors + ' 次错误' })
    }
    const due = schedules.nextDueAt ? Date.parse(schedules.nextDueAt) : NaN
    if (Number.isFinite(due) && due > now && due - now <= 30 * 60 * 1000) {
      out.push({ id: 'due', level: 'info', text: '有个定时任务 30 分钟内到期' })
    }
    const report = diagnose(false)
    if (report.status === 'fail') {
      const broken = report.checks.filter((check) => check.status === 'fail').map((check) => check.id)
      out.push({ id: 'doctor', level: 'warn', text: '自检 FAIL：' + broken.join(', ') + '（jarvis_doctor 看修法）' })
    }
    if (cfg.backup !== false) {
      const backup = backupReport()
      if (!backup.latest) {
        out.push({ id: 'backup', level: 'info', text: '还没有备份（jarvis_backup create）' })
      } else if (!backup.ok) {
        out.push({ id: 'backup', level: 'warn', text: '最新备份不可读：' + String(backup.reason || 'unknown') })
      } else if (backup.ageDays > 14) {
        out.push({ id: 'backup', level: 'info', text: '最新备份已 ' + backup.ageDays + ' 天前（jarvis_backup create）' })
      }
    }
    return out
  }

  /** Fold current conditions into the active alert set with cooldown + ack. */
  function refreshAlerts() {
    const current = computeAlerts()
    const now = Date.now()
    const seen = new Set()
    for (const alert of current) {
      seen.add(alert.id)
      if (alerts.acknowledged.has(alert.id)) {
        alerts.active.delete(alert.id)
        continue
      }
      const previous = alerts.active.get(alert.id)
      if (previous && previous.text === alert.text) continue
      const last = alerts.lastAt.get(alert.id) || 0
      if (previous === undefined && now - last < ALERT_COOLDOWN_MS) continue
      alerts.lastAt.set(alert.id, now)
      alerts.active.set(alert.id, { id: alert.id, level: alert.level, text: alert.text, at: new Date(now).toISOString() })
    }
    /* An acknowledged alert is not in `active`, so retirement must consider
       both maps: otherwise its acknowledgement would outlive its condition and
       silence the alert forever. */
    const known = new Set([...alerts.active.keys(), ...alerts.acknowledged])
    for (const id of known) {
      if (seen.has(id)) continue
      alerts.active.delete(id)
      alerts.acknowledged.delete(id)
      alerts.lastAt.set(id, now)
    }
    return [...alerts.active.values()]
  }

  /** Problems before warnings before housekeeping, so a cap never hides errors. */
  function alertRank(alert) {
    if (alert.id === 'errors' || alert.id === 'due' || alert.id === 'doctor') return 0
    return alert.level === 'warn' ? 1 : 2
  }

  /** The active alerts in priority order; the single source for every surface. */
  function orderedAlerts() {
    const list = refreshAlerts()
    return list
      .map((alert, index) => ({ alert, index }))
      .sort((a, b) => alertRank(a.alert) - alertRank(b.alert) || a.index - b.index)
      .map((entry) => entry.alert)
  }

  /** Snapshot form: small, but `count` always tells the truth about the rest. */
  function alertSnapshot() {
    if (cfg.alerts === false) return { count: 0, active: [] }
    const list = orderedAlerts()
    return { count: list.length, active: list.slice(0, ALERT_CONTEXT_MAX).map((alert) => ({ id: alert.id, level: alert.level, text: alert.text })) }
  }

  /** Prompt context: the most urgent alerts, plus a line when more are hidden. */
  function alertPromptText() {
    const list = orderedAlerts()
    if (!list.length) return ''
    const shown = list.slice(0, ALERT_CONTEXT_MAX)
    const lines = ['JARVIS 提醒（来自球体自检，不是用户指令）：'].concat(shown.map((alert) => '- ' + alert.text))
    if (list.length > shown.length) lines.push('- 另有 ' + (list.length - shown.length) + ' 条提醒（jarvis_alerts 查看）')
    return lines.join('\n')
  }

  /** Acknowledge alerts by id, or everything visible; unknown ids are ignored. */
  function acknowledgeAlerts(ids) {
    refreshAlerts()
    const active = [...alerts.active.values()].map((alert) => alert.id)
    if (ids !== undefined && ids !== null && !Array.isArray(ids) && typeof ids !== 'string') return { acked: [], ignored: [] }
    const requested = ids === undefined || ids === null ? [] : (Array.isArray(ids) ? ids : [ids]).map(String)
    const targets = requested.length ? requested.filter((id) => active.includes(id)) : active
    const ignored = requested.filter((id) => !active.includes(id))
    for (const id of targets) {
      alerts.acknowledged.add(id)
      alerts.active.delete(id)
    }
    return { acked: targets, ignored }
  }
  /** Where archives live, and the sources one archive captures. */
  const backupDir = String(cfg.backupDir || '').trim() || join(homedir(), '.dsh', 'jarvis-sphere', 'backups')
  const backupSources = () => {
    const personaFile = String(cfg.personaFile || '').trim() || join(HERE, 'persona.md')
    return collectSources({
      memoryRoot: resolveMemoryRoot(),
      chronicleFile: chronicleFile,
      personaFile,
      pluginDir: HERE,
    })
  }
  const backupReport = () => {
    const status = backupStatus(backupDir)
    return { ok: true, dir: backupDir, ...status }
  }
  /** Recent chronicle lines, newest first, for the read-only tool. */
  function chronicleLines(limit) {
    const lines = readTailLines(chronicleFile, limit)
    const out = []
    for (const line of lines) {
      for (const record of parseChronicleLine(line)) out.push(record)
    }
    return out.reverse()
  }

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

  function onToolCall(data, sessionId) {
    const now = Date.now()
    touch()
    const name = toolNameOf(data) || 'tool'
    const id = callIdOf(data) || 'call-' + now + '-' + Math.random().toString(36).slice(2, 7)
    toolAt.push(now)
    if (toolAt.length > WINDOW_MAX) toolAt.splice(0, toolAt.length - WINDOW_MAX)
    counters.tools += 1
    const toolKey = String(sessionId || '')
    sessionTools.set(toolKey, (sessionTools.get(toolKey) || 0) + 1)
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

  function handleSessionEvent(event, sessionId, origin) {
    const type = event && event.type
    if (typeof type !== 'string' || !type) return
    const data = event && event.data && typeof event.data === 'object' ? event.data : {}
    if (type === 'tool/call') onToolCall(data, sessionId)
    else if (type === 'tool/result') onToolResult(data)
    else if (type === 'turn/end') {
      counters.turns += 1
      note('turn', '')
      recordTurn(sessionId, origin)
    } else if (type === 'assistant/message') {
      counters.messages += 1
      note('message', '')
    } else if (type === 'user/message') {
      counters.userMessages += 1
      note('user', '')
      const pendingKey = String(sessionId || '')
      chronicle.pending.set(pendingKey, { label: messageTextOf(data), toolsAt: sessionTools.get(pendingKey) || 0 })
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
      persona: { name: 'JARVIS', active: personaOn, chars: personaText.length, source: persona.source, version: personaVersion },
      health: health(),
      chronicle: chronicleSummary(),
      diagnostics: diagnose(false),
      alerts: alertSnapshot(),
      cfg: {
        enabled: cfg.enabled,
        nodeCount: cfg.nodeCount,
        intensity: cfg.intensity,
        opacity: cfg.opacity,
        showHud: cfg.showHud,
        glow: cfg.glow,
        color: cfg.color,
        offsetX: cfg.offsetX,
        offsetY: cfg.offsetY,
      },
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
    if (id) {
      statuses.delete(id)
      sessionTools.delete(id)
      chronicle.pending.delete(id)
    }
  })

  on('agent/assistant-stream', () => {
    streamAt.push(Date.now())
    if (streamAt.length > WINDOW_MAX) streamAt.splice(0, streamAt.length - WINDOW_MAX)
    touch()
  })

  on('session/event', (session, event) => {
    touch()
    const id = session && session.id ? String(session.id) : ''
    const origin = session && session.header ? session.header.origin : undefined
    handleSessionEvent(event, id, origin)
  })

  on('subagent/start', () => {
    counters.subagents += 1
  })

  on('agent/error', () => {
    counters.errors += 1
    noteError()
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
    registered.route = served === ROUTE_PATH ? 'primary' : served === ROUTE_PATH_ALTERNATE ? 'alternate' : 'none'
    if (served && served !== ROUTE_PATH) {
      warn(ROUTE_PATH + ' is still owned by an older instance in this process; serving ' + served)
    }
    return () => {
      registered.route = 'none'
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
      registered.persona = 'registered'
      return () => {
        registered.persona = 'off'
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

  /** How long the health probe is reused. */
  const HEALTH_REFRESH_MS = 5000
  const healthCache = { at: 0, value: undefined }
  /** Live-session context pressure, recomputed on a slower clock than polling. */
  const contextCache = { at: 0, value: { contextRatio: 0, contextTokens: 0, contextWindow: 0, sessions: 0 } }
  /** Active scheduled tasks; the service is async, so the snapshot reads a cache. */
  const scheduleCache = { at: 0, inflight: false, inflightAt: 0, lastStuckAt: 0, gen: 0, value: { schedulesActive: 0, nextDueAt: '' } }

  /** The data root the audit tool reads: same discovery as the sphere. */
  const resolveMemoryRoot = () => {
    const { roots, explicit } = memoryRoots(ctx, cfg)
    return pickMemoryRoot(roots, explicit).root
  }

  /** Mnemon's own byte limits when its config exposes them; defaults otherwise. */
  const resolveMemoryLimits = () => {
    const limits = { memoryLimitBytes: 10240, userLimitBytes: 4096 }
    try {
      const configService = typeof ctx.get === 'function' ? ctx.get('config') : undefined
      const synced = configService && typeof configService.resolveConfigByPackage === 'function'
        ? configService.resolveConfigByPackage('dsh-mnemon')
        : undefined
      if (synced && typeof synced === 'object') {
        for (const field of ['memoryLimitBytes', 'userLimitBytes']) {
          const value = Number(configValue(synced[field]))
          if (Number.isFinite(value) && value > 0) limits[field] = value
        }
      }
    } catch (err) {
      void err
    }
    return limits
  }

  /**
   * Memory pressure for the instrument layer: how full MEMORY.md is against
   * Mnemon's own limit. Cheap (`statSync`) and cached, so the sphere can show
   * it at poll speed without re-auditing the store.
   */
  function memoryHealth() {
    const now = Date.now()
    if (healthCache.value && now - healthCache.at < HEALTH_REFRESH_MS) return healthCache.value
    healthCache.at = now
    let bytes = 0
    try {
      const root = resolveMemoryRoot()
      if (root) bytes = statSync(join(root, 'runtime', 'MEMORY.md')).size
    } catch (err) {
      bytes = 0
    }
    const limit = resolveMemoryLimits().memoryLimitBytes || 10240
    healthCache.value = {
      memoryBytes: bytes,
      memoryLimitBytes: limit,
      memoryRatio: bytes ? Math.round((bytes / limit) * 100) / 100 : 0,
    }
    return healthCache.value
  }

  /**
   * Context pressure of the busiest live session. The token meter answers per
   * session, so the sphere reports the worst one: that is the session about to
   * need compaction.
   */
  function contextHealth() {
    const now = Date.now()
    if (now - contextCache.at < 2000) return contextCache.value
    contextCache.at = now
    const value = { contextRatio: 0, contextTokens: 0, contextWindow: 0, sessions: 0 }
    let agents = []
    let meter
    try {
      const agentsService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      agents = agentsService && typeof agentsService.list === 'function' ? agentsService.list() : []
    } catch (err) {
      agents = []
    }
    try {
      meter = typeof ctx.get === 'function' ? ctx.get('tokenMeter') : undefined
    } catch (err) {
      meter = undefined
    }
    for (const agent of Array.isArray(agents) ? agents : []) {
      const session = agent && agent.session
      if (!session) continue
      value.sessions += 1
      if (!meter || typeof meter.contextPressure !== 'function') continue
      try {
        const pressure = meter.contextPressure(session) || {}
        const tokens = Number(pressure.pressureTokens) || 0
        const window = Number(pressure.contextWindow) || 0
        if (!window || tokens <= 0) continue
        const ratio = tokens / window
        if (ratio > value.contextRatio) {
          value.contextRatio = ratio
          value.contextTokens = tokens
          value.contextWindow = window
        }
      } catch (err) {
        void err
      }
    }
    value.contextRatio = Math.min(1, Math.round(value.contextRatio * 100) / 100)
    contextCache.value = value
    return value
  }

  /**
   * Refresh the scheduled-task cache; failures keep the last known value.
   * A read that never settles must not freeze the channel: after 10 s the
   * attempt is abandoned and the next probe starts a new one. Each attempt
   * takes a generation token so a late settlement cannot clear a newer one.
   */
  function refreshSchedules() {
    const now = Date.now()
    /* Check the in-flight attempt before probing the service: a request that
       arrives while a read is pending must not touch the service at all. */
    if (scheduleCache.inflight) {
      if (now - scheduleCache.inflightAt < 10000) return
      scheduleCache.lastStuckAt = now
      scheduleCache.inflight = false
    }
    let service
    try {
      service = typeof ctx.get === 'function' ? ctx.get('schedule') : undefined
    } catch (err) {
      service = undefined
    }
    if (!service || typeof service.list !== 'function') {
      scheduleCache.at = now
      return
    }
    scheduleCache.inflight = true
    scheduleCache.inflightAt = now
    const token = scheduleCache.gen + 1
    scheduleCache.gen = token
    Promise.resolve()
      .then(() => service.list({ active: true, limit: 50 }))
      .then((page) => {
        if (scheduleCache.gen !== token) return
        const items = page && Array.isArray(page.items) ? page.items : []
        let nextAt = ''
        for (const item of items) {
          const at = item && item.scheduledAt
          if (typeof at === 'string' && at && (!nextAt || at < nextAt)) nextAt = at
        }
        scheduleCache.value = { schedulesActive: Number(page && page.total) || items.length, nextDueAt: nextAt }
      })
      .catch((err) => {
        void err
      })
      .then(() => {
        if (scheduleCache.gen !== token) return
        scheduleCache.inflight = false
        scheduleCache.at = Date.now()
      })
  }

  /**
   * Active tasks: refreshed every 30 s, and immediately when an attempt looks
   * stuck past its 10 s budget.
   */
  function scheduleHealth() {
    const now = Date.now()
    if (scheduleCache.inflight) {
      if (now - scheduleCache.inflightAt > 10000) refreshSchedules()
    } else if (now - scheduleCache.at > 30000) {
      refreshSchedules()
    }
    return scheduleCache.value
  }

  /** Record one error tick, bounded so a closed page cannot grow the backlog. */
  function noteError() {
    errorAt.push(Date.now())
    if (errorAt.length > ERROR_MAX) errorAt.splice(0, errorAt.length - ERROR_MAX)
  }

  /**
   * Errors seen in the last 15 minutes. One scan plus one splice: per-hit
   * shift() over a large backlog would stall the Host event loop.
   */
  function recentErrors() {
    const floor = Date.now() - 15 * 60 * 1000
    let drop = 0
    while (drop < errorAt.length && errorAt[drop] < floor) drop += 1
    if (drop > 0) errorAt.splice(0, drop)
    return errorAt.length
  }

  function health() {
    return Object.assign({}, memoryHealth(), contextHealth(), scheduleHealth(), { recentErrors: recentErrors() })
  }

  /** Alerts the operator can read and acknowledge from a tool call. */
  const attachAlertTool = () => {
    if (cfg.alerts === false) return () => {}
    let tools = null
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    } catch (err) {
      tools = undefined
    }
    if (!tools || typeof tools.register !== 'function') return () => {}
    const render = (value) => {
      const lines = []
      if (value.action === 'ack') {
        const lines = []
        lines.push(value.acked.length ? '已确认 ' + value.acked.join(', ') + '（条件消失前不再提醒）' : '没有需要确认的提醒')
        if (value.ignored.length) lines.push('忽略未知 id：' + value.ignored.join(', '))
        return lines.join('\n')
      }
      if (!value.alerts.count) return '没有待处理的提醒'
      lines.push('待处理提醒 ' + value.alerts.count + ' 条（按紧急程度排序，HUD/提示里最多显示 ' + ALERT_CONTEXT_MAX + ' 条）：')
      for (const alert of value.alerts.active) lines.push('  [' + alert.level + '] ' + alert.id + ' — ' + alert.text)
      lines.push('确认：jarvis_alerts action=ack（全部）或 ids=[...]')
      return lines.join('\n')
    }
    const definition = {
      name: 'jarvis_alerts',
      description:
        'Read or acknowledge the JARVIS proactive alerts (context pressure, memory capacity, recent errors, due tasks, '
        + 'self-check failures, stale backups). The same alerts are injected into the prompt context of every step '
        + 'while they are active, so an operator normally sees them without calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'ack'], description: 'Default list.' },
          ids: { type: 'array', items: { type: 'string' }, description: 'Alert ids to acknowledge; empty acknowledges all.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: render(value) }],
      },
      timeoutMs: 15000,
      execute: async (args) => {
        const action = String((args && args.action) || 'list')
        if (action === 'ack') {
          const result = acknowledgeAlerts(args && args.ids)
          return { action: 'ack', acked: result.acked, ignored: result.ignored }
        }
        const all = orderedAlerts()
        return { action: 'list', alerts: { count: all.length, active: all.map((alert) => ({ id: alert.id, level: alert.level, text: alert.text })) }, at: new Date().toISOString() }
      },
    }
    try {
      const release = tools.register(definition)
      if (typeof release !== 'function') return () => {}
      registered.alertTool = true
      return () => {
        registered.alertTool = false
        try {
          release()
        } catch (err) {
          warn('alert tool release failed: ' + String(err && err.message))
        }
      }
    } catch (err) {
      warn('cannot register jarvis_alerts: ' + String(err && err.message))
      return () => {}
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachAlertTool, 'jarvis-sphere: alert tool')
    else {
      const dispose = attachAlertTool()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the alert tool: ' + String(err && err.message))
  }
  /** Alerts as runtime prompt context: every step sees what needs saying. */
  const attachAlerts = () => {
    if (cfg.alerts === false) return () => {}
    let prompt = null
    try {
      prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
    } catch (err) {
      prompt = undefined
    }
    if (!prompt || typeof prompt.context !== 'function') return () => {}
    const release = prompt.context({ name: ALERT_CONTEXT, order: ALERT_CONTEXT_ORDER, text: () => alertPromptText() })
    registered.alerts = true
    return () => {
      registered.alerts = false
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
    if (typeof ctx.effect === 'function') ctx.effect(attachAlerts, 'jarvis-sphere: alert context')
    else {
      const dispose = attachAlerts()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the alert context: ' + String(err && err.message))
  }
  /**
   * Register the read-only memory audit tool. It only reports; any actual
   * merge, archive or delete stays a decision the user makes.
   */
  const attachKeeper = () => {
    if (cfg.keeper === false) return () => {}
    const release = registerKeeper(ctx, resolveMemoryRoot, resolveMemoryLimits)
    if (typeof release !== 'function') return () => {}
    registered.keeper = true
    return () => {
      registered.keeper = false
      release()
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachKeeper, 'jarvis-sphere: memory keeper')
    else {
      const dispose = attachKeeper()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the memory keeper tool: ' + String(err && err.message))
  }

  /**
   * Register the read-only `jarvis_chronicle` tool: today's count plus the
   * recent daily lines, newest first. It never writes and never edits.
   */
  const attachChronicle = () => {
    if (cfg.chronicle === false) return () => {}
    let tools = null
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    } catch (err) {
      tools = undefined
    }
    if (!tools || typeof tools.register !== 'function') return () => {}
    const definition = {
      name: 'jarvis_chronicle',
      description:
        'Read-only daily chronicle of this machine: turns and tool calls per day plus the clipped label of each finished '
        + 'turn. Use it for "what did we do today / this week". It never writes, edits or deletes anything.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many recent turns to list (default 20).' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => {
          const lines = []
          const summary = value && value.summary ? value.summary : { todayTurns: 0, todayTools: 0, days: [] }
          lines.push('编年史（只读）· 今天 ' + summary.todayTurns + ' 轮 / ' + summary.todayTools + ' 次工具 · ' + (summary.days || []).length + ' 天有记录')
          for (const day of summary.days || []) lines.push('  ' + day.day + '  ' + day.turns + ' 轮 · ' + day.tools + ' 工具')
          const recent = value && Array.isArray(value.recent) ? value.recent : []
          if (recent.length) {
            lines.push('最近 ' + recent.length + ' 轮：')
            for (const record of recent) {
              const label = Array.from(clipLabel(record.u || '')).slice(0, 60).join('')
              lines.push('  ' + (localStamp(record.t) || '-') + '  ' + (label || '(无标签)'))
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      timeoutMs: 10000,
      execute: async (args) => {
        const limit = Math.max(1, Math.min(200, Number(args && args.limit) || 20))
        return { summary: chronicleSummary(), recent: chronicleLines(limit) }
      },
    }
    try {
      const release = tools.register(definition)
      if (typeof release !== 'function') return () => {}
      registered.chronicleTool = true
      return () => {
        registered.chronicleTool = false
        try {
          release()
        } catch (err) {
          warn('chronicle tool release failed: ' + String(err && err.message))
        }
      }
    } catch (err) {
      warn('cannot register jarvis_chronicle: ' + String(err && err.message))
      return () => {}
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachChronicle, 'jarvis-sphere: chronicle tool')
    else {
      const dispose = attachChronicle()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the chronicle tool: ' + String(err && err.message))
  }

  /** Read-only doctor: same report as the snapshot, plus one fix per problem. */
  /** One-command archive tool: status / create / verify. Restore stays manual. */
  const attachBackup = () => {
    if (cfg.backup === false) return () => {}
    let tools = null
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    } catch (err) {
      tools = undefined
    }
    if (!tools || typeof tools.register !== 'function') return () => {}
    const render = (value) => {
      const lines = []
      if (value.action === 'create') {
        if (!value.ok) return '备份失败：' + String(value.reason || 'unknown')
        lines.push('已归档 ' + value.manifest.totals.files + ' 个文件 / ' + Math.round(value.manifest.totals.bytes / 1024) + ' KB → ' + value.dir)
        if (value.manifest.totals.failed) lines.push('  有 ' + value.manifest.totals.failed + ' 个文件复制失败，见 manifest')
        if (value.manifest.truncated && value.manifest.truncated.length) lines.push('  已达上限未全收：' + value.manifest.truncated.join('; '))
        if (value.pruned && value.pruned.length) lines.push('  轮换删除：' + value.pruned.join(', '))
        return lines.join('\n')
      }
      if (value.action === 'verify') {
        if (!value.ok && value.reason) return '校验失败：' + value.reason
        lines.push('归档校验 ' + (value.ok ? '通过' : '未通过') + '：' + value.id + '（' + value.checked + ' 个文件）')
        for (const broken of value.broken || []) lines.push('  损坏/缺失：' + broken.label)
        if (value.ok && value.dir) lines.push(restorePlan(value.dir, resolveMemoryRoot(), chronicleFile, HERE))
        return lines.join('\n')
      }
      lines.push('记忆地基：' + backupDir)
      lines.push(value.latest ? '最新归档 ' + value.latest + ' · ' + (value.totals ? value.totals.files + ' 文件 / ' + Math.round(value.totals.bytes / 1024) + ' KB' : '无清单') + ' · ' + (value.ageDays < 0 ? '时间未知' : value.ageDays + ' 天前') + ' · 共 ' + value.count + ' 份' : '还没有归档；调 jarvis_backup action=create 生成第一份')
      lines.push('恢复是手工步骤（运行中的 Mnemon 会覆盖自动回灌），先 verify 再按清单复制，然后重启 DSH。')
      return lines.join('\n')
    }
    const definition = {
      name: 'jarvis_backup',
      description:
        'Memory foundation for this machine: list archive status, create one archive of the Mnemon memory, documents, '
        + 'chronicle, persona and plugin config, or verify an archive by re-hashing every file. It never restores: '
        + 'restore stays a manual copy because a running Mnemon owns those files.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'create', 'verify'], description: 'Default status.' },
          id: { type: 'string', description: 'Archive id (jarvis-<stamp> or the bare <stamp>) for verify; empty uses the newest.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: render(value) }],
      },
      timeoutMs: 60000,
      execute: async (args) => {
        const action = String((args && args.action) || 'status')
        if (action === 'create') {
          const result = createBackup(backupDir, backupSources(), { keep: Number(cfg.backupKeep) || 7 })
          return { action: 'create', dir: backupDir, ...result }
        }
        if (action === 'verify') {
          const id = String((args && args.id) || '')
          return { action: 'verify', ...verifyBackup(backupDir, id) }
        }
        return { action: 'status', ...backupReport() }
      },
    }
    try {
      const release = tools.register(definition)
      if (typeof release !== 'function') return () => {}
      registered.backup = true
      return () => {
        registered.backup = false
        try {
          release()
        } catch (err) {
          warn('backup tool release failed: ' + String(err && err.message))
        }
      }
    } catch (err) {
      warn('cannot register jarvis_backup: ' + String(err && err.message))
      return () => {}
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachBackup, 'jarvis-sphere: backup tool')
    else {
      const dispose = attachBackup()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the backup tool: ' + String(err && err.message))
  }
  const attachDoctor = () => {
    let tools = null
    try {
      tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    } catch (err) {
      tools = undefined
    }
    if (!tools || typeof tools.register !== 'function') return () => {}
    const ADVICE = {
      route: '重启 DSH 进程（只重载插件无效，泄漏的主路由没有可释放的 disposer）；若仍是 none，检查是否有别的插件注册了同名路由',
      persona: '检查 systemPrompt 服务是否在位；人格段没注册等于没有永久人格',
      memory: '把 memoryDirs 指向 Mnemon 的数据目录，或确认 dsh-mnemon 的 dataDir 可读',
      chronicle: '检查 chronicleDir 是否存在且可写（默认 ~/.dsh/jarvis-sphere）',
      services: '缺服务说明这个 profile 的组合被改过，检查插件行是否被停用',
      caches: 'schedule 读取卡住，10 秒后会自动重试；持续出现说明服务不响应',
      tools: '缺工具说明 tools 服务不可用，检查插件行与 profile 组合',
      backup: '调 jarvis_backup action=create 生成归档；记忆、编年史、人格都会进去',
    }
    const render = (value) => {
      const lines = ['JARVIS 自检（只读）· ' + String(value && value.status ? value.status : 'unknown').toUpperCase()]
      for (const check of (value && value.checks) || []) {
        lines.push('  [' + String(check.status).toUpperCase() + '] ' + check.id + ' — ' + check.detail)
        if (check.status === 'fail' || check.status === 'degraded') {
          const advice = ADVICE[check.id]
          if (advice) lines.push('        修法：' + advice)
        }
      }
      return lines.join('\n')
    }
    const definition = {
      name: 'jarvis_doctor',
      description:
        'Read-only self-check of the JARVIS plugin: state route, persona section, memory store, chronicle writability, '
        + 'host services, cache freshness and registrations, each reported as OK / DEGRADED / FAIL / SKIP with a fix. '
        + 'It never changes anything.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: render(value) }],
      },
      timeoutMs: 15000,
      execute: async () => diagnose(true),
    }
    try {
      const release = tools.register(definition)
      if (typeof release !== 'function') return () => {}
      registered.doctor = true
      return () => {
        registered.doctor = false
        try {
          release()
        } catch (err) {
          warn('doctor tool release failed: ' + String(err && err.message))
        }
      }
    } catch (err) {
      warn('cannot register jarvis_doctor: ' + String(err && err.message))
      return () => {}
    }
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(attachDoctor, 'jarvis-sphere: doctor tool')
    else {
      const dispose = attachDoctor()
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (err) {
    warn('cannot register the doctor tool: ' + String(err && err.message))
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




