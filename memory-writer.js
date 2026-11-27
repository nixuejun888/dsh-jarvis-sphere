/**
 * Memory writer — the execution half of the audit.
 *
 * `jarvis_memory_review` only reports: merge, archive and delete were decisions
 * a human had to carry out by hand. This module performs those decisions, with
 * rules that keep it safe:
 *
 *  - it only touches the Markdown projections (`MEMORY.md`, `USER.md`), never
 *    the SQLite bodies that Mnemon owns;
 *  - a dry run is the default, an entry selector is validated against an
 *    expected preview, and a write needs a complete snapshot first;
 *  - the replaced file is written to a temp path, the removed bodies are archived
 *    under a name that cannot collide, and only then is the file renamed into
 *    place — a failure removes every artefact it created.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Files the writer is allowed to touch, relative to the memory root. */
const ALLOWED_FILES = new Set(['runtime/MEMORY.md', 'runtime/USER.md'])
/** Separator line between entries in a projection file. */
const SEPARATOR_SPLIT = /^[ \t]*§[ \t]*$/mu

/** Split a projection file into entries; empty chunks are dropped. */
export function parseEntries(text) {
  return String(text || '')
    .split(SEPARATOR_SPLIT)
    .map((body) => body.replace(/^\s+|\s+$/gu, ''))
    .filter((body) => body.length > 0)
}

/** How a file spells its line endings. */
function eolOf(text) {
  return String(text || '').includes('\r\n') ? '\r\n' : '\n'
}

/** Render entries back to the file format, using the file's own line endings. */
export function renderEntries(entries, eol = '\n') {
  if (!entries.length) return ''
  const normalized = entries.map((body) => String(body).replace(/\r\n/gu, '\n').replace(/\n/gu, eol))
  return normalized.join(eol + '§' + eol) + eol
}

/** A short preview for logs and reports. */
function preview(text, limit = 60) {
  const flat = String(text || '').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/** Guard the library surface: only the two projections may be addressed. */
export function resolveProjection(root, relativeFile) {
  if (!ALLOWED_FILES.has(relativeFile)) return null
  return join(root, relativeFile)
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
  if (expected.length > indexes.length) {
    return { ok: false, reason: 'expected[] has more previews than entries[]' }
  }
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
 * @returns `{ ok, action, before, after, removed, added, text }` or a reason.
 */
export function planOperation(text, request) {
  const source = String(text || '')
  const action = String((request && request.action) || '').trim()
  const entries = parseEntries(source)
  if (!entries.length) return { ok: false, reason: 'the file has no entries to edit' }
  if (!['archive', 'delete', 'rewrite', 'merge'].includes(action)) {
    return { ok: false, reason: 'action must be archive, delete, rewrite or merge' }
  }
  const selected = selectEntries(entries, request)
  if (!selected.ok) return { ok: false, reason: selected.reason }
  if (action === 'merge' && selected.indexes.length < 2) {
    return { ok: false, reason: 'merge needs at least two entries' }
  }
  if (action === 'rewrite' && selected.indexes.length !== 1) {
    return { ok: false, reason: 'rewrite works on exactly one entry; use merge for several' }
  }
  let replacement = ''
  if (action === 'rewrite' || action === 'merge') {
    replacement = String((request && request.text) || '').trim()
    if (!replacement) return { ok: false, reason: action + ' needs text' }
    /* Validate the replacement the same way the file is parsed, so "one entry"
       cannot be bypassed by a different separator spelling. */
    const replacementEntries = parseEntries(replacement)
    if (replacementEntries.length !== 1) return { ok: false, reason: 'text must be a single entry' }
    replacement = replacementEntries[0]
  }
  const drop = new Set(selected.indexes)
  const removed = []
  const replaced = []
  entries.forEach((body, index) => {
    if (!drop.has(index)) return
    removed.push({ index: index + 1, preview: preview(body), bytes: Buffer.byteLength(body, 'utf8') })
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
  const eol = eolOf(source)
  const before = renderEntries(entries, eol)
  const after = renderEntries(next, eol)
  return {
    ok: true,
    action,
    entries: entries.length,
    beforeEntries: entries.length,
    afterEntries: next.length,
    beforeBytes: Buffer.byteLength(source, 'utf8'),
    afterBytes: Buffer.byteLength(after, 'utf8'),
    removed,
    replaced,
    added: replacement ? { preview: preview(replacement), bytes: Buffer.byteLength(replacement, 'utf8') } : null,
    eol,
    text: after,
  }
}

/** Append one audit line; returns whether the audit was actually recorded. */
export function appendAudit(file, record) {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, JSON.stringify(record) + '\n')
    return true
  } catch (err) {
    return false
  }
}

/** Remove a file if it exists, swallowing the failure. */
function removeQuietly(file) {
  try {
    if (existsSync(file)) unlinkSync(file)
  } catch (err) {
    void err
  }
}

/** Archive file name that cannot collide, even within the same millisecond. */
function archivePath(archiveDir, relativeFile, now) {
  const base = join(archiveDir, relativeFile.replace(/[\\/]/gu, '-') + '.' + new Date(now).toISOString().replace(/[:.]/gu, '-').slice(0, 23))
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? base + '.md' : base + '-' + n + '.md'
    if (!existsSync(candidate)) return candidate
  }
  return base + '-' + String(now) + '.md'
}

/**
 * Apply a plan: write the new content to a temp file, archive the removed
 * bodies, then rename the temp into place. Every failure removes what it made.
 * The caller is responsible for taking a complete snapshot first.
 */
export function applyPlan(root, relativeFile, plan, options = {}) {
  const file = resolveProjection(root, relativeFile)
  if (!file) return { ok: false, reason: 'refusing to write ' + relativeFile + ': not a projection file' }
  const now = options.now ?? Date.now()
  const eol = plan.eol || '\n'
  const archiveDir = join(root, 'runtime', 'archived', 'manual')
  try {
    mkdirSync(archiveDir, { recursive: true })
  } catch (err) {
    return { ok: false, reason: 'cannot create the archive directory: ' + String(err && err.message) }
  }
  const archiveFile = archivePath(archiveDir, relativeFile, now)
  const temp = file + '.jarvis-tmp'

  /* 1. the replacement lands in a temp file first */
  try {
    writeFileSync(temp, plan.text)
  } catch (err) {
    removeQuietly(temp)
    return { ok: false, reason: 'cannot write ' + temp + ': ' + String(err && err.message) }
  }

  /* 2. the removed bodies are archived under a fresh name */
  let archiveWritten = false
  if (plan.replaced && plan.replaced.length) {
    const header = '# ' + plan.action + ' · ' + new Date(now).toISOString() + ' · ' + relativeFile + eol + eol
    try {
      writeFileSync(archiveFile, header + plan.replaced.join(eol + '§' + eol) + eol, { flag: 'wx' })
      archiveWritten = true
    } catch (err) {
      removeQuietly(temp)
      return { ok: false, reason: 'cannot write the archive file: ' + String(err && err.message) }
    }
  }

  /* 3. swap it in; on failure remove both artefacts so nothing lies around */
  try {
    renameSync(temp, file)
  } catch (err) {
    removeQuietly(temp)
    if (archiveWritten) removeQuietly(archiveFile)
    return { ok: false, reason: 'cannot replace ' + file + ': ' + String(err && err.message) }
  }
  return { ok: true, file, archiveFile: archiveWritten ? archiveFile : '' }
}

/** Read a projection file, or null when it is missing or not allowed. */
export function readProjection(root, relativeFile) {
  const file = resolveProjection(root, relativeFile)
  if (!file) return null
  try {
    return readFileSync(file, 'utf8')
  } catch (err) {
    return null
  }
}
