/**
 * Jarvis keeper — memory lifecycle audit.
 *
 * Reads the Mnemon runtime store and the document index, then reports what a
 * careful librarian would flag: exact duplicates, near duplicates, stale
 * entries worth archiving, oversized entries, and capacity pressure. It is
 * strictly read-only: nothing here edits, merges, deletes or archives a single
 * memory. Acting on a suggestion stays a human decision.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Runtime store limits Mnemon ships with; overridden by its own config. */
const DEFAULT_MEMORY_LIMIT_BYTES = 10240
const DEFAULT_USER_LIMIT_BYTES = 4096
/** Above this many entries the pairwise scan degrades to exact-match bucketing. */
const PAIRWISE_LIMIT = 600
/**
 * Near-duplicate threshold on max(Jaccard, containment). Calibrated on a real
 * store: a restated rule scores ~0.81 while unrelated entries stay under 0.40.
 */
const NEAR_THRESHOLD = 0.62
/** Entries older than this and not critical become archive candidates. */
const STALE_DAYS = 120
/** Entries longer than this are hard to reuse and should be split or demoted. */
const OVERSIZED_CHARS = 900

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return undefined
  }
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch (err) {
    return 0
  }
}

/** Case- and punctuation-insensitive form used only for comparison. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/gu, ' ')
    .replace(/[。；;，,、：:!！?？"“”'‘’()（）[\]【】]/gu, '')
    .trim()
}

function tokensOf(text) {
  const norm = normalize(text)
  const set = new Set()
  for (let i = 0; i + 1 < norm.length; i += 1) set.add(norm.slice(i, i + 2))
  for (const word of norm.split(/[^a-z0-9_.-]+/u)) if (word.length > 2) set.add(word)
  return set
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * How much one entry is contained in the other. A short rule restated with an
 * extra clause keeps a high score here even when Jaccard stays low, which is
 * the common shape of a duplicate in a memory store.
 */
function containment(a, b) {
  const smaller = Math.min(a.size, b.size)
  if (smaller < 6) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / smaller
}

/** Symmetric similarity used for near-duplicate detection. */
function similarity(a, b) {
  return Math.max(jaccard(a, b), containment(a, b))
}

/**
 * Secret shapes that must never reach a transcript through a preview. Memory
 * text is quoted into the model's tool result, so every preview is scrubbed.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\b[A-Fa-f0-9]{32,}\b/gu,
  /* keyed secret: redact the keyword and the credential-shaped value after it */
  /(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]?\s*[A-Za-z0-9!@#$%^&*_\-+.]{6,}/giu,
]

/** Replace secret-looking spans with a marker. */
function scrub(text) {
  let out = String(text || '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

function preview(text, limit = 70) {
  const flat = scrub(String(text || '').replace(/\s+/gu, ' ').trim())
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

function ageDaysOf(entry, now) {
  const stamp = Date.parse(entry.updated_at || entry.created_at || '')
  return Number.isFinite(stamp) ? Math.max(0, Math.round((now - stamp) / 86400000)) : -1
}

/**
 * Audit one runtime store.
 * @param root - Mnemon data root containing `runtime/` and `documents/`.
 * @param options - clock and thresholds (tests override them).
 * @returns a read-only report; no entry is ever modified.
 */
export function auditStore(root, options = {}) {
  const now = options.now ?? Date.now()
  const staleDays = options.staleDays ?? STALE_DAYS
  const nearThreshold = options.nearThreshold ?? NEAR_THRESHOLD
  const pairwiseLimit = options.pairwiseLimit ?? PAIRWISE_LIMIT
  const memoryLimitBytes = options.limits?.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES
  const userLimitBytes = options.limits?.userLimitBytes ?? DEFAULT_USER_LIMIT_BYTES

  const files = {
    runtime: join(root, 'runtime', 'memories.json'),
    user: join(root, 'runtime', 'USER.md'),
    memory: join(root, 'runtime', 'MEMORY.md'),
    documents: join(root, 'documents', 'index.json'),
    bodies: join(root, 'data', '.dsh-memory-bodies.json'),
  }
  if (!existsSync(files.runtime)) {
    return { ok: false, reason: 'runtime/memories.json not found', root }
  }

  const store = readJson(files.runtime)
  const entries = store && Array.isArray(store.entries) ? store.entries : []
  const documents = (() => {
    const index = readJson(files.documents)
    return index && Array.isArray(index.documents) ? index.documents : []
  })()
  const bodies = (() => {
    const manifest = readJson(files.bodies)
    return manifest && Array.isArray(manifest.bodies) ? manifest.bodies : []
  })()

  const duplicates = []
  const near = []
  const stale = []
  const oversized = []
  let fresh = 0
  const normIndex = new Map()

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (!entry || typeof entry.content !== 'string') continue
    const text = entry.content
    const norm = normalize(text)
    const age = ageDaysOf(entry, now)
    if (age >= 0 && age < 1) fresh += 1
    if (text.length > OVERSIZED_CHARS) oversized.push({ index: i, chars: text.length, preview: preview(text) })
    if (age > staleDays && entry.importance !== 'critical') stale.push({ index: i, ageDays: age, preview: preview(text) })

    const seenAt = normIndex.get(norm)
    if (seenAt !== undefined) {
      duplicates.push({ a: seenAt, b: i, preview: preview(text) })
      continue
    }
    normIndex.set(norm, i)
  }

  if (entries.length <= pairwiseLimit) {
    const tokenCache = entries.map((entry) => (entry && typeof entry.content === 'string' ? tokensOf(entry.content) : new Set()))
    for (let i = 0; i < entries.length; i += 1) {
      if (!tokenCache[i].size) continue
      for (let j = i + 1; j < entries.length; j += 1) {
        if (!tokenCache[j].size) continue
        if (normalize(entries[i].content) === normalize(entries[j].content)) continue
        const score = similarity(tokenCache[i], tokenCache[j])
        if (score >= nearThreshold) near.push({ a: i, b: j, score: Math.round(score * 100) / 100, preview: preview(entries[i].content) })
      }
    }
  }

  stale.sort((a, b) => b.ageDays - a.ageDays)

  const memoryBytes = fileSize(files.memory)
  const userBytes = fileSize(files.user)
  const memoryRatio = memoryBytes ? Math.round((memoryBytes / memoryLimitBytes) * 100) / 100 : 0
  const userRatio = userBytes ? Math.round((userBytes / userLimitBytes) * 100) / 100 : 0

  const suggestions = []
  if (memoryRatio >= 0.85) suggestions.push('MEMORY.md 已用 ' + Math.round(memoryRatio * 100) + '%，先合并下面的重复条目再继续写新记忆。')
  if (duplicates.length) suggestions.push('有 ' + duplicates.length + ' 组完全重复，建议合并成一条并保留最高重要度。')
  if (near.length) suggestions.push('有 ' + near.length + ' 组近重复（相似度 ≥ ' + nearThreshold + '），建议人工确认后合并。')
  if (stale.length) suggestions.push('有 ' + stale.length + ' 条超过 ' + staleDays + ' 天且非 critical，可作为档案移出热记忆。')
  if (oversized.length) suggestions.push('有 ' + oversized.length + ' 条超过 ' + OVERSIZED_CHARS + ' 字，建议拆成「规则 + 详情」两条。')
  if (!suggestions.length) suggestions.push('没有需要处理的条目：容量、重复、陈旧三项都正常。')
  suggestions.push('本工具只读：以上只是建议，改写记忆需要用户确认。')
  suggestions.push('条目编号是当前 memories.json 里的位置，任何增删都会让编号后移，动手前先用同样的审计复核一次。')

  return {
    ok: true,
    root,
    checkedAt: new Date(now).toISOString(),
    capacity: {
      memoryBytes,
      userBytes,
      memoryRatio,
      userRatio,
      memoryLimitBytes,
      userLimitBytes,
    },
    counts: {
      entries: entries.length,
      user: entries.filter((entry) => entry && entry.target === 'user').length,
      memory: entries.filter((entry) => entry && entry.target !== 'user').length,
      spaces: bodies.length,
      documents: documents.length,
      fresh,
    },
    truncated: {
      duplicates: Math.max(0, duplicates.length - 20),
      near: Math.max(0, near.length - 20),
      stale: Math.max(0, stale.length - 20),
      oversized: Math.max(0, oversized.length - 20),
    },
    duplicates: duplicates.slice(0, 20),
    near: near.slice(0, 20),
    stale: stale.slice(0, 20),
    oversized: oversized.slice(0, 20),
    suggestions,
  }
}

/** Render the report as the short text a model reads in the tool result. */
export function renderReport(report) {
  if (!report || !report.ok) return '记忆审计失败：' + String((report && report.reason) || '未知原因')
  const lines = []
  lines.push('记忆审计（只读）' + (report.root ? ' · ' + report.root : ''))
  lines.push(
    '容量：MEMORY.md ' + report.capacity.memoryBytes + ' B / ' + report.capacity.memoryLimitBytes + ' B（' +
      Math.round(report.capacity.memoryRatio * 100) + '%）· USER.md ' + report.capacity.userBytes + ' B / ' +
      report.capacity.userLimitBytes + ' B（' + Math.round(report.capacity.userRatio * 100) + '%）',
  )
  lines.push(
    '库存：' + report.counts.entries + ' 条（用户画像 ' + report.counts.user + ' / 工作记忆 ' + report.counts.memory +
      '）· 空间 ' + report.counts.spaces + ' · 文档 ' + report.counts.documents + ' · 24h 内新增 ' + report.counts.fresh,
  )
  if (report.duplicates.length) {
    lines.push('完全重复 ' + report.duplicates.length + ' 组：')
    for (const item of report.duplicates) lines.push('  #' + item.a + ' ≡ #' + item.b + '  ' + item.preview)
  }
  if (report.near.length) {
    lines.push('近重复 ' + report.near.length + ' 组：')
    for (const item of report.near) lines.push('  #' + item.a + ' ≈ #' + item.b + '（' + item.score + '）  ' + item.preview)
  }
  if (report.stale.length) {
    lines.push('陈旧可归档 ' + report.stale.length + ' 条（最久 ' + report.stale[0].ageDays + ' 天）：')
    for (const item of report.stale.slice(0, 5)) lines.push('  #' + item.index + ' ' + item.ageDays + ' 天  ' + item.preview)
  }
  if (report.oversized.length) {
    lines.push('过长 ' + report.oversized.length + ' 条：')
    for (const item of report.oversized) lines.push('  #' + item.index + ' ' + item.chars + ' 字  ' + item.preview)
  }
  lines.push('建议：')
  for (const suggestion of report.suggestions) lines.push('  - ' + suggestion)
  const hidden = report.truncated
    ? (report.truncated.duplicates + report.truncated.near + report.truncated.stale + report.truncated.oversized)
    : 0
  if (hidden > 0) lines.push('（另有 ' + hidden + ' 组候选被截断，未列出，可先处理上面这些。）')
  return lines.join('\n')
}

/**
 * Register the read-only audit tool for as long as this plugin lives.
 * @param ctx - plugin context owning the registration.
 * @param resolveRoot - resolves the Mnemon data root at call time.
 * @param resolveLimits - resolves Mnemon's byte limits, if the row sets them.
 * @returns a disposer, or a no-op when the tools service is unavailable.
 */
export function registerKeeper(ctx, resolveRoot, resolveLimits) {
  let tools = null
  try {
    tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  } catch (err) {
    void err
  }
  /* null tells the caller nothing was registered, so a self-check must not claim it was. */
  if (!tools || typeof tools.register !== 'function') return null

  const definition = {
    name: 'jarvis_memory_review',
    description:
      'Read-only memory audit for this machine: capacity of USER.md/MEMORY.md, exact and near duplicates, stale entries '
      + 'that could be archived, oversized entries, and concrete next steps. Never edits, merges or deletes anything.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderReport(value) }],
    },
    timeoutMs: 15000,
    execute: async () => {
      const root = resolveRoot()
      if (!root) return { ok: false, reason: 'no Mnemon data root was found' }
      let limits
      try {
        limits = typeof resolveLimits === 'function' ? resolveLimits() : undefined
      } catch (err) {
        limits = undefined
      }
      return auditStore(root, limits ? { limits } : {})
    },
  }

  let release = null
  try {
    release = tools.register(definition)
  } catch (err) {
    if (ctx.logger && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('jarvis-sphere: cannot register jarvis_memory_review: ' + String(err && err.message))
    }
    return null
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
