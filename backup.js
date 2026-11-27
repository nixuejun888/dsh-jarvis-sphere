/**
 * Jarvis backup — one-command archive of everything that makes this assistant
 * itself: the Mnemon runtime memory, the document bodies, the memory-space
 * databases, the chronicle, the persona file and the plugin configuration.
 *
 * The archive is a directory (no zip dependency) holding the files plus a
 * manifest with a sha256 per file. `verify` re-hashes every file, so a backup
 * that rotted on disk is reported instead of being trusted, and a malformed
 * manifest is a readable failure rather than an exception.
 *
 * Restore is deliberately not automated: a running Mnemon owns those files and
 * would overwrite a restore; `verify` prints the exact copy plan instead.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** Manifest file name inside every archive directory. */
const MANIFEST = 'manifest.json'
/** Archives kept by default before the oldest is pruned. */
const DEFAULT_KEEP = 7
/** Document bodies archived per run before the collection is capped. */
const DOC_LIMIT = 500
/** Memory-space database files archived per run. */
const DB_LIMIT = 200

function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (err) {
    return ''
  }
}

/** Files under one directory, bounded so a runaway tree cannot stall a turn. */
function listFiles(root, limit = 2000, filter) {
  const out = []
  const walk = (dir) => {
    if (out.length >= limit) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && (!filter || filter(entry.name))) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * Sources worth archiving, with a stable label per file.
 * @returns `{ sources, truncated }`: `truncated` names any collection that hit
 * its cap, so a partial archive can never look complete.
 */
export function collectSources({ memoryRoot, chronicleFile, personaFile, pluginDir }) {
  const sources = []
  const truncated = []
  const add = (label, file, optional) => {
    if (!file || !existsSync(file)) return
    sources.push({ label, file })
  }
  if (memoryRoot) {
    add('runtime/memories.json', join(memoryRoot, 'runtime', 'memories.json'))
    add('runtime/USER.md', join(memoryRoot, 'runtime', 'USER.md'), true)
    add('runtime/MEMORY.md', join(memoryRoot, 'runtime', 'MEMORY.md'), true)
    add('documents/index.json', join(memoryRoot, 'documents', 'index.json'), true)
    add('data/.dsh-memory-bodies.json', join(memoryRoot, 'data', '.dsh-memory-bodies.json'), true)

    const docsDir = join(memoryRoot, 'documents', 'active')
    if (existsSync(docsDir)) {
      const docs = listFiles(docsDir, DOC_LIMIT + 1)
      if (docs.length > DOC_LIMIT) truncated.push('documents/active (first ' + DOC_LIMIT + ' of ' + docs.length + '+)')
      for (const file of docs.slice(0, DOC_LIMIT)) {
        sources.push({ label: 'documents/active/' + file.slice(docsDir.length + 1).replace(/\\/gu, '/'), file })
      }
    }

    /* Memory-space bodies live in SQLite; a live copy is taken together with
       its -wal/-shm so SQLite can recover the copy consistently. */
    const dataDir = join(memoryRoot, 'data')
    if (existsSync(dataDir)) {
      const dbs = listFiles(dataDir, DB_LIMIT + 1, (name) => /^mnemon\.db(-wal|-shm)?$/u.test(name))
      if (dbs.length > DB_LIMIT) truncated.push('data/**/mnemon.db (first ' + DB_LIMIT + ' of ' + dbs.length + '+)')
      for (const file of dbs.slice(0, DB_LIMIT)) {
        sources.push({ label: 'data/' + file.slice(dataDir.length + 1).replace(/\\/gu, '/'), file })
      }
    }

    const archivedDir = join(memoryRoot, 'runtime', 'archived')
    if (existsSync(archivedDir)) {
      for (const file of listFiles(archivedDir, DOC_LIMIT, (name) => name.endsWith('.json'))) {
        sources.push({ label: 'runtime/archived/' + file.slice(archivedDir.length + 1).replace(/\\/gu, '/'), file })
      }
    }
  }
  add('chronicle.jsonl', chronicleFile, true)
  add('persona.md', personaFile, true)
  if (pluginDir) {
    add('plugin/package.json', join(pluginDir, 'package.json'), true)
    add('plugin/cordis.patch.yml', join(pluginDir, 'cordis.patch.yml'), true)
  }
  return { sources, truncated }
}

/** Archive directory name with millisecond precision, e.g. `jarvis-…T11-59-44-123`. */
function archiveName(now) {
  return 'jarvis-' + new Date(now).toISOString().replace(/[:.]/gu, '-').slice(0, 23)
}

/**
 * Write one archive.
 * @returns the manifest, or a failure describing why nothing was written.
 */
export function createBackup(root, collected, options = {}) {
  const keep = Number.isFinite(options.keep) ? Math.max(1, Math.round(options.keep)) : DEFAULT_KEEP
  const now = options.now ?? Date.now()
  const { sources, truncated } = Array.isArray(collected) ? { sources: collected, truncated: [] } : collected || { sources: [], truncated: [] }
  if (!sources.length) return { ok: false, reason: 'no sources to archive' }
  /* Same-millisecond creates must not share a directory: a second archive in
     the same tick gets a numeric suffix instead of overwriting the first. */
  let name = archiveName(now)
  let dir = join(root, name)
  for (let n = 2; existsSync(dir) && n < 100; n += 1) {
    name = archiveName(now) + '-' + n
    dir = join(root, name)
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, reason: 'cannot create ' + dir + ': ' + String(err && err.message) }
  }
  const files = []
  let bytes = 0
  for (const source of sources) {
    const target = join(dir, source.label)
    try {
      mkdirSync(join(target, '..'), { recursive: true })
      copyFileSync(source.file, target)
      const size = statSync(target).size
      bytes += size
      files.push({ label: source.label, bytes: size, sha256: sha256(target) })
    } catch (err) {
      /* One unreadable source must not sink the whole archive. */
      files.push({ label: source.label, bytes: 0, sha256: '', error: String(err && err.message) })
    }
  }
  const manifest = {
    version: 1,
    id: name,
    createdAt: new Date(now).toISOString(),
    files,
    truncated,
    totals: { files: files.length, bytes, failed: files.filter((file) => file.error).length, truncated: truncated.length > 0 },
  }
  try {
    writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  } catch (err) {
    return { ok: false, reason: 'cannot write manifest: ' + String(err && err.message) }
  }
  const pruned = prune(root, keep)
  return { ok: true, dir, manifest, pruned }
}

/** Keep the newest `keep` archives (never below one); returns pruned names. */
export function prune(root, keep) {
  const bounded = Number.isFinite(keep) ? Math.max(1, Math.round(keep)) : DEFAULT_KEEP
  const pruned = []
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('jarvis-'))
      .map((entry) => entry.name)
      .sort()
  } catch (err) {
    return pruned
  }
  const excess = entries.length - bounded
  for (let i = 0; i < excess; i += 1) {
    try {
      rmSync(join(root, entries[i]), { recursive: true, force: true })
      pruned.push(entries[i])
    } catch (err) {
      void err
    }
  }
  return pruned
}

/** Newest archive directory name, or '' when there is none. */
export function latestBackup(root) {
  try {
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('jarvis-'))
      .map((entry) => entry.name)
      .sort()
    return names.length ? names[names.length - 1] : ''
  } catch (err) {
    return ''
  }
}

/** Read a manifest defensively; returns `{ manifest }` or `{ reason }`. */
function readManifest(dir) {
  let raw
  try {
    raw = readFileSync(join(dir, MANIFEST), 'utf8')
  } catch (err) {
    return { reason: 'manifest is missing (' + String(err && err.message) + ')' }
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (err) {
    return { reason: 'manifest is not valid JSON (' + String(err && err.message) + ')' }
  }
  if (!manifest || typeof manifest !== 'object') return { reason: 'manifest is not an object' }
  if (!Array.isArray(manifest.files)) return { reason: 'manifest has no files[]' }
  return { manifest }
}

/** Summarize the newest archive without hashing anything. */
export function backupStatus(root) {
  const latest = latestBackup(root)
  if (!latest) return { ok: true, latest: '', ageDays: -1, count: 0, totals: null, files: 0 }
  let count = 0
  try {
    count = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('jarvis-')).length
  } catch (err) {
    count = 0
  }
  const read = readManifest(join(root, latest))
  if (!read.manifest) return { ok: false, latest, reason: read.reason, ageDays: -1, count, totals: null, files: 0 }
  const manifest = read.manifest
  const created = manifest.createdAt ? Date.parse(manifest.createdAt) : NaN
  const ageDays = Number.isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : -1
  return {
    ok: true,
    latest,
    ageDays,
    count,
    totals: manifest.totals || null,
    files: manifest.files.length,
    truncated: Array.isArray(manifest.truncated) ? manifest.truncated : [],
  }
}

/** Accept either `jarvis-<stamp>` or `<stamp>` as an archive id. */
function resolveArchive(root, id) {
  if (!id) return join(root, latestBackup(root))
  const direct = join(root, id)
  if (existsSync(direct)) return direct
  if (!String(id).startsWith('jarvis-')) {
    const prefixed = join(root, 'jarvis-' + id)
    if (existsSync(prefixed)) return prefixed
  }
  return direct
}

/**
 * Re-hash one archive and compare with its manifest. Malformed manifests are
 * reported, never thrown: one bad entry becomes a `broken` row.
 */
export function verifyBackup(root, id) {
  if (!id && !latestBackup(root)) return { ok: false, reason: 'no archive found under ' + root }
  const dir = resolveArchive(root, id)
  const read = readManifest(dir)
  if (!read.manifest) return { ok: false, reason: read.reason, dir }
  const manifest = read.manifest
  const checked = []
  for (const file of manifest.files) {
    if (!file || typeof file.label !== 'string' || !file.label) {
      checked.push({ label: '<bad entry>', expected: '', actual: '', ok: false })
      continue
    }
    const path = join(dir, file.label)
    const actual = existsSync(path) ? sha256(path) : ''
    checked.push({
      label: file.label,
      expected: typeof file.sha256 === 'string' ? file.sha256 : '',
      actual,
      ok: !!file.sha256 && actual === file.sha256,
    })
  }
  const broken = checked.filter((file) => !file.ok)
  if (checked.length === 0) {
    return { ok: false, reason: 'manifest lists no files', dir, checked: 0, broken: [], manifest }
  }
  return {
    ok: broken.length === 0,
    id: dir.split(/[\\/]/u).pop(),
    dir,
    checked: checked.length,
    broken,
    manifest,
  }
}

/** Exact copy plan for a verified archive; it only prints, never writes. */
export function restorePlan(archiveDir, memoryRoot, chronicleFile, pluginDir) {
  const lines = ['恢复是手工步骤（运行中的 Mnemon 会覆盖自动回灌）：', '  先完全退出 DSH，再按下面逐项复制：']
  const pairs = []
  if (memoryRoot) {
    pairs.push(['runtime/memories.json', join(memoryRoot, 'runtime', 'memories.json')])
    pairs.push(['runtime/USER.md', join(memoryRoot, 'runtime', 'USER.md')])
    pairs.push(['runtime/MEMORY.md', join(memoryRoot, 'runtime', 'MEMORY.md')])
    pairs.push(['documents/', join(memoryRoot, 'documents')])
    pairs.push(['data/', join(memoryRoot, 'data')])
    pairs.push(['runtime/archived/', join(memoryRoot, 'runtime', 'archived')])
  }
  if (chronicleFile) pairs.push(['chronicle.jsonl', chronicleFile])
  if (pluginDir) {
    pairs.push(['persona.md', join(pluginDir, 'persona.md')])
    pairs.push(['plugin/package.json', join(pluginDir, 'package.json')])
    pairs.push(['plugin/cordis.patch.yml', join(pluginDir, 'cordis.patch.yml')])
  }
  for (const [label, dest] of pairs) {
    const source = join(archiveDir, label)
    if (!existsSync(source)) continue
    lines.push('  ' + source + ' → ' + dest)
  }
  lines.push('  复制完重启 DSH，让 Mnemon 重新加载记忆库；随后调 jarvis_doctor 确认 memory 为 OK。')
  return lines.join('\n')
}
