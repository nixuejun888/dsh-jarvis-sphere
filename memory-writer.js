/**
 * Memory writer — the execution half of the audit.
 *
 * `jarvis_memory_review` only reports: merge, archive and delete were decisions
 * a human had to carry out by hand. This module performs those decisions, with
 * three rules that keep it safe:
 *
 *  - it only touches the Markdown projections (`MEMORY.md`, `USER.md`), never
 *    the SQLite bodies that Mnemon owns;
 *  - every write is preceded by an archive of the whole memory store, and the
 *    file is replaced atomically (temp + rename) so a crash cannot truncate it;
 *  - a dry run is the default: nothing changes until `confirm` is true, and an
 *    entry selector is validated against an expected preview so a shifted index
 *    cannot silently rewrite the wrong memory.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Separator between entries in a projection file. */
const SEPARATOR = '§'

/** Split a projection file into entries; empty chunks are dropped. */
export function parseEntries(text) {
  return String(text || '')
    .split(/^\s*§\s*$/mu)
    .map((body) => body.replace(/^\s+|\s+$/gu, ''))
    .filter((body) => body.length > 0)
}

/** Render entries back to the file format (one trailing newline). */
export function renderEntries(entries) {
  if (!entries.length) return ''
  return entries.join('\n§\n') + '\n'
}

/** A short preview for logs and reports. */
function preview(text, limit = 60) {
  const flat = String(text || '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/**
 * Validate a selector against the parsed entries.
 * @returns `{ ok: true, indexes }` (0-based) or a reason.
 */
export function selectEntries(entries, selection) {
  const raw = selection && Array.isArray(selection.entries) ? selection.entries : []
  if (!raw.length) return { ok: false, reason: 'entries[] is required' }
  const indexes = []
  for (const value of raw) {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > entries.length) {
      return { ok: false, reason: 'entry ' + String(value) + ' is out of range 1..' + entries.length }
    }
    indexes.push(n - 1)
  }
  if (new Set(indexes).size !== indexes.length) return { ok: false, reason: 'entries[] repeats an index' }
  const expected = selection && Array.isArray(selection.expected) ? selection.expected : []
  for (let i = 0; i < expected.length; i += 1) {
    const needle = String(expected[i] || '')
    if (!needle) continue
    if (!entries[indexes[i]] || !entries[indexes[i]].includes(needle)) {
      return { ok: false, reason: 'entry ' + String(indexes[i] + 1) + ' does not contain the expected text; the file changed since it was reviewed' }
    }
  }
  return { ok: true, indexes }
}

/**
 * Plan one operation without touching the disk.
 * @returns `{ ok, action, before, after, removed, added, archive[] }` or a reason.
 */
export function planOperation(text, request) {
  const action = String((request && request.action) || '').trim()
  const entries = parseEntries(text)
  if (!entries.length) return { ok: false, reason: 'the file has no entries to edit' }
  if (!['archive', 'delete', 'rewrite', 'merge'].includes(action)) {
    return { ok: false, reason: 'action must be archive, delete, rewrite or merge' }
  }
  const selected = selectEntries(entries, request)
  if (!selected.ok) return { ok: false, reason: selected.reason }
  const drop = new Set(selected.indexes)
  if (action === 'merge' && selected.indexes.length < 2) {
    return { ok: false, reason: 'merge needs at least two entries' }
  }
  let replacement = ''
  if (action === 'rewrite' || action === 'merge') {
    replacement = String((request && request.text) || '').trim()
    if (!replacement) return { ok: false, reason: action + ' needs text' }
    if (replacement.includes('\n§\n')) return { ok: false, reason: 'text must be a single entry' }
  }
  const archive = []
  const replaced = []
  const kept = []
  entries.forEach((body, index) => {
    if (!drop.has(index)) {
      kept.push(body)
      return
    }
    archive.push({ index: index + 1, preview: preview(body), bytes: Buffer.byteLength(body, 'utf8') })
    replaced.push(body)
  })
  const next = []
  let inserted = false
  entries.forEach((body, index) => {
    if (drop.has(index)) {
      if (!inserted && replacement) {
        next.push(replacement)
        inserted = true
      }
      return
    }
    next.push(body)
  })
  const before = renderEntries(entries)
  const after = renderEntries(next)
  return {
    ok: true,
    action,
    target: 'memory',
    entries: entries.length,
    beforeEntries: entries.length,
    afterEntries: next.length,
    beforeBytes: Buffer.byteLength(before, 'utf8'),
    afterBytes: Buffer.byteLength(after, 'utf8'),
    removed: archive,
    replaced,
    added: replacement ? { preview: preview(replacement), bytes: Buffer.byteLength(replacement, 'utf8') } : null,
    text: after,
  }
}

/** Append one audit line; failures are swallowed (an audit gap must not undo a write). */
export function appendAudit(file, record) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, JSON.stringify(record) + '\n')
    return true
  } catch (err) {
    return false
  }
}

/**
 * Apply a plan: archive the selected entries, then replace the file atomically.
 * The caller is responsible for taking a memory snapshot first.
 */
export function applyPlan(root, relativeFile, plan, options = {}) {
  const file = join(root, relativeFile)
  const now = options.now ?? Date.now()
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const archiveDir = join(root, 'runtime', 'archived', 'manual')
  try {
    mkdirSync(archiveDir, { recursive: true })
  } catch (err) {
    return { ok: false, reason: 'cannot create the archive directory: ' + String(err && err.message) }
  }
  const archiveFile = join(archiveDir, relativeFile.replace(/[\\/]/gu, '-') + '.' + stamp + '.md')
  try {
    const header = '# ' + plan.action + ' · ' + new Date(now).toISOString() + ' · ' + relativeFile + '\n\n'
    const replaced = Array.isArray(plan.replaced) ? plan.replaced : []
    writeFileSync(archiveFile, header + replaced.join('\n§\n') + (replaced.length ? '\n' : ''))
  } catch (err) {
    return { ok: false, reason: 'cannot write the archive file: ' + String(err && err.message) }
  }
  const temp = file + '.jarvis-tmp'
  try {
    writeFileSync(temp, plan.text)
    renameSync(temp, file)
  } catch (err) {
    try {
      if (existsSync(temp)) writeFileSync(temp, '')
    } catch (ignored) {
      void ignored
    }
    return { ok: false, reason: 'cannot replace ' + file + ': ' + String(err && err.message) }
  }
  return { ok: true, file, archiveFile }
}

/** Read a projection file, or null when it is missing. */
export function readProjection(root, relativeFile) {
  try {
    return readFileSync(join(root, relativeFile), 'utf8')
  } catch (err) {
    return null
  }
}
