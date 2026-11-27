/**
 * Jarvis backup — one-command archive of everything that makes this assistant
 * itself: the Mnemon runtime memory, the document bodies, the chronicle, the
 * persona file and the plugin configuration.
 *
 * The archive is a directory (no zip dependency) holding a manifest with a
 * sha256 per file. `verify` re-hashes every file, so a backup that rotted on
 * disk is reported instead of being trusted. Restore is deliberately not
 * automated: a running Mnemon owns those files and would overwrite a restore;
 * `verify` prints the exact copy plan instead.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

/** Manifest file name inside every archive directory. */
const MANIFEST = 'manifest.json'
/** Archives kept by default before the oldest is pruned. */
const DEFAULT_KEEP = 7

function sha256(file) {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex')
  } catch (err) {
    return ''
  }
}

/** Files under one directory, bounded so a runaway tree cannot stall a turn. */
function listFiles(root, limit = 2000) {
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
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}

/** Sources worth archiving, with a stable label per file. */
export function collectSources({ memoryRoot, chronicleFile, personaFile, pluginDir }) {
  const sources = []
  const add = (label, file, optional) => {
    if (!file) return
    if (!existsSync(file)) {
      if (optional) return
      return
    }
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
      for (const file of listFiles(docsDir, 500)) {
        sources.push({ label: 'documents/active/' + file.slice(docsDir.length + 1).replace(/\\/gu, '/'), file })
      }
    }
  }
  add('chronicle.jsonl', chronicleFile, true)
  add('persona.md', personaFile, true)
  if (pluginDir) {
    add('plugin/package.json', join(pluginDir, 'package.json'), true)
    add('plugin/cordis.patch.yml', join(pluginDir, 'cordis.patch.yml'), true)
  }
  return sources
}

/** Timestamped archive directory name, e.g. `2026-11-27T11-55-00`. */
function stamp(now) {
  return new Date(now).toISOString().replace(/:/gu, '-').slice(0, 19)
}

/**
 * Write one archive.
 * @returns the manifest, or a failure describing why nothing was written.
 */
export function createBackup(root, sources, options = {}) {
  const keep = Number.isFinite(options.keep) ? Math.max(1, Math.round(options.keep)) : DEFAULT_KEEP
  const now = options.now ?? Date.now()
  const dir = join(root, 'jarvis-' + stamp(now))
  if (!sources.length) return { ok: false, reason: 'no sources to archive' }
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
    id: stamp(now),
    createdAt: new Date(now).toISOString(),
    files,
    totals: { files: files.length, bytes, failed: files.filter((file) => file.error).length },
  }
  try {
    writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  } catch (err) {
    return { ok: false, reason: 'cannot write manifest: ' + String(err && err.message) }
  }
  const pruned = prune(root, keep)
  return { ok: true, dir, manifest, pruned }
}

/** Keep the newest `keep` archives; returns the pruned directory names. */
export function prune(root, keep) {
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
  const excess = entries.length - keep
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

/** Summarize the newest archive without hashing anything. */
export function backupStatus(root) {
  const latest = latestBackup(root)
  if (!latest) return { ok: true, latest: '', ageDays: -1, totals: null, count: 0 }
  let count = 0
  try {
    count = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('jarvis-')).length
  } catch (err) {
    count = 0
  }
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(root, latest, MANIFEST), 'utf8'))
  } catch (err) {
    manifest = null
  }
  const created = manifest && manifest.createdAt ? Date.parse(manifest.createdAt) : NaN
  const ageDays = Number.isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : -1
  return {
    ok: !!manifest,
    latest,
    ageDays,
    count,
    totals: manifest ? manifest.totals : null,
    files: manifest ? manifest.files.length : 0,
  }
}

/**
 * Re-hash one archive and compare with its manifest.
 * @returns per-file verdicts; a missing archive reports a reason, never throws.
 */
export function verifyBackup(root, id) {
  const target = id ? join(root, id) : join(root, latestBackup(root))
  if (!id && !latestBackup(root)) return { ok: false, reason: 'no archive found under ' + root }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(target, MANIFEST), 'utf8'))
  } catch (err) {
    return { ok: false, reason: 'cannot read manifest in ' + target + ': ' + String(err && err.message) }
  }
  const checked = []
  for (const file of manifest.files || []) {
    const path = join(target, file.label)
    const actual = existsSync(path) ? sha256(path) : ''
    checked.push({
      label: file.label,
      expected: file.sha256,
      actual,
      ok: !!file.sha256 && actual === file.sha256,
    })
  }
  const broken = checked.filter((file) => !file.ok)
  return {
    ok: broken.length === 0,
    id: target.split(/[\\/]/u).pop(),
    dir: target,
    checked: checked.length,
    broken,
    manifest,
  }
}

/** Move relative to an archive root for the restore plan text. */
export function restorePlan(archiveDir, memoryRoot, chronicleFile, pluginDir) {
  const lines = ['恢复是手工步骤（运行中的 Mnemon 会覆盖自动回灌）：']
  const pairs = [
    ['runtime/', memoryRoot ? join(memoryRoot, 'runtime') : ''],
    ['documents/', memoryRoot ? join(memoryRoot, 'documents') : ''],
    ['data/.dsh-memory-bodies.json', memoryRoot ? join(memoryRoot, 'data') : ''],
    ['chronicle.jsonl', chronicleFile || ''],
    ['persona.md', pluginDir || ''],
  ]
  for (const [label, dest] of pairs) {
    if (!dest) continue
    const source = join(archiveDir, label)
    if (!existsSync(source)) continue
    lines.push('  copy ' + source + ' → ' + dest + '（相对路径：' + relative(archiveDir, source) + '）')
  }
  lines.push('  然后重启 DSH，让 Mnemon 重新加载记忆库。')
  return lines.join('\n')
}
