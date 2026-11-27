// Harness for the execution half: dry run by default, archive + snapshot before
// a write, atomic replacement, and a selector that cannot silently drift.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { parseEntries, renderEntries, planOperation, selectEntries } from '../memory-writer.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-writer-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
const memoryFile = join(memoryDir, 'runtime', 'MEMORY.md')
const userFile = join(memoryDir, 'runtime', 'USER.md')
writeFileSync(memoryFile, '第一条：规则 A\n§\n第二条：规则 B\n§\n第三条：规则 C\n')
writeFileSync(userFile, '用户偏好：一句话\n')
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))

function makeCtx() {
  const routes = new Map()
  const registered = []
  const ctx = {
    on() {
      return () => {}
    },
    effect(execute) {
      const dispose = execute()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (name === 'config') return { resolveConfigByPackage: () => ({ dataDir: memoryDir }) }
      if (name === 'systemPrompt') return { section: () => () => {}, context: () => () => {} }
      if (name === 'tools') {
        return {
          register(definition) {
            registered.push(definition)
            return () => {
              const at = registered.indexOf(definition)
              if (at >= 0) registered.splice(at, 1)
            }
          },
        }
      }
      if (name === 'agents') return { list: () => [] }
      if (name === 'tokenMeter') return { contextPressure: () => ({}) }
      if (name === 'schedule') return { list: async () => ({ items: [], total: 0 }) }
      if (name === 'webServer') return {}
      return undefined
    },
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  return { ctx, routes, registered }
}

// --- 1. parsing and rendering round-trip ---
{
  const text = readFileSync(memoryFile, 'utf8')
  const entries = parseEntries(text)
  check('parse splits the separator', entries.length === 3, entries.length)
  check('parse trims bodies', entries[0] === '第一条：规则 A', entries[0])
  check('render restores the format', renderEntries(entries) === text, JSON.stringify(renderEntries(entries)))
}

// --- 2. the selector refuses drift ---
{
  const entries = parseEntries(readFileSync(memoryFile, 'utf8'))
  check('selector accepts a matching preview', selectEntries(entries, { entries: [2], expected: ['规则 B'] }).ok === true, selectEntries(entries, { entries: [2], expected: ['规则 B'] }))
  const drift = selectEntries(entries, { entries: [2], expected: ['规则 X'] })
  check('selector refuses a drifted preview', drift.ok === false && /expected text/u.test(drift.reason), drift)
  const range = selectEntries(entries, { entries: [9] })
  check('selector refuses an out-of-range index', range.ok === false && /out of range/u.test(range.reason), range)
  const dup = selectEntries(entries, { entries: [1, 1] })
  check('selector refuses duplicates', dup.ok === false && /repeats/u.test(dup.reason), dup)
}

// --- 3. plans: archive / rewrite / merge / delete ---
{
  const text = readFileSync(memoryFile, 'utf8')
  const archive = planOperation(text, { action: 'archive', entries: [2] })
  check('archive plan drops the entry', archive.ok && parseEntries(archive.text).length === 2, archive.ok && parseEntries(archive.text).length)
  check('archive plan keeps the original body', archive.replaced.length === 1 && archive.replaced[0].includes('规则 B'), archive.replaced)
  const rewrite = planOperation(text, { action: 'rewrite', entries: [1], text: '第一条：规则 A（收紧）' })
  check('rewrite replaces in place', rewrite.ok && parseEntries(rewrite.text)[0] === '第一条：规则 A（收紧）', rewrite.ok && parseEntries(rewrite.text)[0])
  const merge = planOperation(text, { action: 'merge', entries: [1, 2], text: '合并：A 与 B' })
  check('merge replaces two with one', merge.ok && parseEntries(merge.text).length === 2 && parseEntries(merge.text)[0] === '合并：A 与 B', merge.ok && parseEntries(merge.text).length)
  const one = planOperation(text, { action: 'merge', entries: [1], text: 'x' })
  check('merge refuses a single entry', one.ok === false, one.reason)
  const noText = planOperation(text, { action: 'rewrite', entries: [1] })
  check('rewrite refuses without text', noText.ok === false, noText.reason)
  const multi = planOperation(text, { action: 'rewrite', entries: [1], text: 'a\n§\nb' })
  check('rewrite refuses a multi-entry body', multi.ok === false, multi.reason)
}

// --- 4. the tool: dry run writes nothing, confirm writes and archives ---
{
  const { ctx, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'chronicle'), backupDir: join(root, 'backups'), alerts: false })
  const tool = registered.find((definition) => definition.name === 'jarvis_memory_apply')
  check('the writer tool is registered', !!tool, registered.map((d) => d.name))

  const before = readFileSync(memoryFile, 'utf8')
  const dry = await tool.execute({ action: 'archive', entries: [2], expected: ['规则 B'] }, {})
  check('a dry run reports a plan', dry.ok === true && dry.applied === false, dry)
  check('a dry run writes nothing', readFileSync(memoryFile, 'utf8') === before, readFileSync(memoryFile, 'utf8') === before)

  const drift = await tool.execute({ action: 'archive', entries: [2], expected: ['规则 X'], confirm: true }, {})
  check('a drifted selector refuses the write', drift.ok === false && /expected text/u.test(drift.reason), drift)
  check('a refused write leaves the file alone', readFileSync(memoryFile, 'utf8') === before, readFileSync(memoryFile, 'utf8') === before)

  const applied = await tool.execute({ action: 'archive', entries: [2], expected: ['规则 B'], confirm: true }, {})
  check('a confirmed write applies', applied.ok === true && applied.applied === true && applied.afterEntries === 2, applied)
  const after = readFileSync(memoryFile, 'utf8')
  check('the archived entry left the file', !after.includes('规则 B') && after.includes('规则 A') && after.includes('规则 C'), after)
  const archives = readdirSync(join(memoryDir, 'runtime', 'archived', 'manual'))
  check('the archive file holds the original text', archives.length === 1 && readFileSync(join(memoryDir, 'runtime', 'archived', 'manual', archives[0]), 'utf8').includes('规则 B'), archives)
  const auditLines = readFileSync(join(root, 'chronicle', 'memory-audit.jsonl'), 'utf8').trim().split('\n')
  check('an audit line records the write', auditLines.length === 1 && JSON.parse(auditLines[0]).action === 'archive', auditLines)
  const snapshot = JSON.parse(auditLines[0]).snapshot
  check('a snapshot was taken before the write', typeof snapshot === 'string' && existsSync(snapshot), snapshot)
}

// --- 5. user projection is a separate target ---
{
  const { ctx, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'chronicle-2'), backupDir: join(root, 'backups-2'), alerts: false })
  const tool = registered.find((definition) => definition.name === 'jarvis_memory_apply')
  const before = readFileSync(userFile, 'utf8')
  const dry = await tool.execute({ action: 'rewrite', target: 'user', entries: [1], text: '用户偏好：更短' }, {})
  check('the user target is a dry run by default', dry.ok === true && dry.file === 'runtime/USER.md', dry)
  check('the user dry run writes nothing', readFileSync(userFile, 'utf8') === before, readFileSync(userFile, 'utf8') === before)
  const applied = await tool.execute({ action: 'rewrite', target: 'user', entries: [1], text: '用户偏好：更短', confirm: true }, {})
  check('the user rewrite applies', applied.ok === true && readFileSync(userFile, 'utf8').includes('更短'), readFileSync(userFile, 'utf8'))
  const untouched = readFileSync(memoryFile, 'utf8')
  check('the memory projection is untouched by a user write', untouched.includes('规则 A'), untouched.length)
}

// --- 6. the review's hard cases: collisions, temp residue, separator variants ---
{
  const { applyPlan } = await import('../memory-writer.js')
  const scratch = join(root, 'hard')
  mkdirSync(join(scratch, 'runtime'), { recursive: true })
  const file = join(scratch, 'runtime', 'MEMORY.md')
  writeFileSync(file, 'A\n§\nB\n§\nC\n')

  // same-millisecond writes must not overwrite each other's archive
  const now = Date.now()
  const planOne = planOperation(readFileSync(file, 'utf8'), { action: 'archive', entries: [2], expected: ['B'] })
  const first = applyPlan(scratch, 'runtime/MEMORY.md', planOne, { now })
  const planTwo = planOperation(readFileSync(file, 'utf8'), { action: 'archive', entries: [2], expected: ['C'] })
  const second = applyPlan(scratch, 'runtime/MEMORY.md', planTwo, { now })
  check('same-millisecond writes get distinct archives', first.ok && second.ok && first.archiveFile !== second.archiveFile, [first.archiveFile, second.archiveFile])
  check('both archives survive', readFileSync(second.archiveFile, 'utf8').includes('C') && readFileSync(first.archiveFile, 'utf8').includes('B'), [readFileSync(first.archiveFile, 'utf8').includes('B'), readFileSync(second.archiveFile, 'utf8').includes('C')])
  check('no temp file after success', !existsSync(file + '.jarvis-tmp'), existsSync(file + '.jarvis-tmp'))

  // a failed rename must leave neither a temp file nor an archive
  const locked = join(root, 'locked')
  mkdirSync(join(locked, 'runtime'), { recursive: true })
  mkdirSync(join(locked, 'runtime', 'MEMORY.md'), { recursive: true })
  const lockedPlan = planOperation('A\n§\nB\n', { action: 'archive', entries: [2] })
  const failed = applyPlan(locked, 'runtime/MEMORY.md', lockedPlan, { now: Date.now() })
  check('a failed replace reports a reason', failed.ok === false && /cannot replace/u.test(failed.reason), failed)
  check('a failed replace leaves no temp file', !existsSync(join(locked, 'runtime', 'MEMORY.md.jarvis-tmp')), existsSync(join(locked, 'runtime', 'MEMORY.md.jarvis-tmp')))
  check('a failed replace leaves no archive', !existsSync(join(locked, 'runtime', 'archived', 'manual')) || readdirSync(join(locked, 'runtime', 'archived', 'manual')).length === 0, existsSync(join(locked, 'runtime', 'archived', 'manual')) ? readdirSync(join(locked, 'runtime', 'archived', 'manual')) : [])

  // separator variants must not pass the single-entry check
  const base = 'A\n§\nB\n§\nC\n'
  for (const [name, body] of [['crlf', 'x\r\n§\r\nY'], ['spaced', 'x\n § \nY'], ['mixed', 'x\n§\r\nY']]) {
    const plan = planOperation(base, { action: 'rewrite', entries: [1], text: body })
    check('rewrite rejects a multi-entry replacement (' + name + ')', plan.ok === false && /single entry/u.test(plan.reason), plan.reason)
  }
  check('rewrite rejects two selected entries', planOperation(base, { action: 'rewrite', entries: [1, 2], text: 'x' }).ok === false, planOperation(base, { action: 'rewrite', entries: [1, 2], text: 'x' }).reason)
  check('expected longer than entries is refused', selectEntries(parseEntries(base), { entries: [1], expected: ['a', 'b'] }).ok === false, selectEntries(parseEntries(base), { entries: [1], expected: ['a', 'b'] }).reason)

  // the library only accepts the two projections
  check('the library refuses another file', applyPlan(scratch, 'runtime/OTHER.md', planOne, { now: Date.now() }).ok === false, applyPlan(scratch, 'runtime/OTHER.md', planOne, { now: Date.now() }).reason)

  // CRLF files keep their line endings
  const crlfFile = join(root, 'crlf', 'runtime', 'MEMORY.md')
  mkdirSync(join(root, 'crlf', 'runtime'), { recursive: true })
  writeFileSync(crlfFile, 'A\r\n§\r\nB\r\n')
  const crlfPlan = planOperation(readFileSync(crlfFile, 'utf8'), { action: 'archive', entries: [2] })
  applyPlan(join(root, 'crlf'), 'runtime/MEMORY.md', crlfPlan, { now: Date.now() })
  check('a CRLF file stays CRLF', readFileSync(crlfFile, 'utf8').includes('\r\n'), JSON.stringify(readFileSync(crlfFile, 'utf8')))
}
// --- 7. the write gates: incomplete snapshot, drift while snapshotting, audit failure ---
{
  const { parseChunks, renderEntries } = await import('../memory-writer.js')
  const chunks = parseChunks('A\n§\nB\n')
  check('parseChunks keeps the raw text', chunks.length === 2 && chunks[0].raw === 'A', chunks.map((c) => c.raw))
  check('renderEntries still joins with the separator', renderEntries(['A', 'B']) === 'A\n§\nB\n', renderEntries(['A', 'B']))

  // an incomplete snapshot (a failed source) must refuse the write
  const badRoot = join(root, 'bad-snapshot')
  mkdirSync(join(badRoot, 'runtime'), { recursive: true })
  writeFileSync(join(badRoot, 'runtime', 'MEMORY.md'), 'A\n§\nB\n')
  writeFileSync(join(badRoot, 'runtime', 'memories.json'), '{}')
  const backupBlocked = join(root, 'backup-blocked')
  writeFileSync(backupBlocked, 'not a directory')
  const blocked = makeCtx()
  apply(blocked.ctx, { nodeCount: 300, memoryDirs: [badRoot], chronicleDir: join(root, 'chron-blocked'), backupDir: join(backupBlocked, 'nested'), alerts: false })
  const blockedTool = blocked.registered.find((definition) => definition.name === 'jarvis_memory_apply')
  const refused = await blockedTool.execute({ action: 'archive', entries: [2], expected: ['B'], confirm: true }, {})
  check('a failed snapshot refuses the write', refused.ok === false && /snapshot/u.test(refused.reason), refused)
  check('a refused write leaves the file untouched', readFileSync(join(badRoot, 'runtime', 'MEMORY.md'), 'utf8') === 'A\n§\nB\n', readFileSync(join(badRoot, 'runtime', 'MEMORY.md'), 'utf8'))
}

// --- 8. untested entries keep their exact bytes (whitespace, BOM) ---
{
  const spaced = join(root, 'spaced')
  mkdirSync(join(spaced, 'runtime'), { recursive: true })
  const file = join(spaced, 'runtime', 'MEMORY.md')
  writeFileSync(file, '\uFEFFA\n\n§\nB\n§\nC\n')
  const plan = planOperation(readFileSync(file, 'utf8'), { action: 'archive', entries: [3], expected: ['C'] })
  const { applyPlan } = await import('../memory-writer.js')
  const written = applyPlan(spaced, 'runtime/MEMORY.md', plan, { now: Date.now() })
  check('an archive write keeps the BOM and the spacing of untouched entries', written.ok && readFileSync(file, 'utf8').startsWith('\uFEFFA\n\n'), JSON.stringify(readFileSync(file, 'utf8')))
}
rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
