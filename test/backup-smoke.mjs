// Harness for the memory foundation: one archive of memory + documents +
// chronicle + persona + config, sha256 verify, rotation, and no restore.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { backupStatus, collectSources, createBackup, prune, verifyBackup } from '../backup.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-backup-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
mkdirSync(join(memoryDir, 'documents', 'active'), { recursive: true })
mkdirSync(join(memoryDir, 'data'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [{ content: 'x' }] }))
writeFileSync(join(memoryDir, 'runtime', 'MEMORY.md'), 'MEMORY\n')
writeFileSync(join(memoryDir, 'runtime', 'USER.md'), 'USER\n')
writeFileSync(join(memoryDir, 'documents', 'index.json'), JSON.stringify({ version: 1, documents: [{ id: 'd1' }] }))
writeFileSync(join(memoryDir, 'documents', 'active', 'doc-one.md'), '# doc one\n')
writeFileSync(join(memoryDir, 'data', '.dsh-memory-bodies.json'), JSON.stringify({ version: 1, bodies: [] }))
const chronicle = join(root, 'chronicle.jsonl')
writeFileSync(chronicle, JSON.stringify({ d: '2026-11-27', s: 's', u: 'x', tools: 1 }) + '\n')
const pluginDir = join(root, 'plugin')
mkdirSync(pluginDir, { recursive: true })
writeFileSync(join(pluginDir, 'persona.md'), '人格\n')
writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'x' }))
writeFileSync(join(pluginDir, 'cordis.patch.yml'), '- insert: []\n')
const backups = join(root, 'backups')

// --- 1. sources are discovered ---
const collected = collectSources({ memoryRoot: memoryDir, chronicleFile: chronicle, personaFile: join(pluginDir, 'persona.md'), pluginDir })
const sources = collected.sources
const labels = sources.map((s) => s.label)
check('collects the runtime store', labels.includes('runtime/memories.json') && labels.includes('runtime/MEMORY.md'), labels)
check('collects document bodies', labels.includes('documents/active/doc-one.md'), labels.filter((l) => l.startsWith('documents/active')))
check('collects chronicle, persona and config', labels.includes('chronicle.jsonl') && labels.includes('persona.md') && labels.includes('plugin/cordis.patch.yml'), labels)

// --- 2. create writes a manifest with hashes ---
const base = Date.now() - 3600_000
const created = createBackup(backups, collected, { now: base, keep: 7 })
check('create succeeds', created.ok === true, created.ok)
check('manifest counts every file', created.manifest?.totals?.files === sources.length, created.manifest?.totals)
check('manifest records bytes and hashes', created.manifest?.files?.every((f) => f.bytes > 0 && /^[a-f0-9]{64}$/u.test(f.sha256)), created.manifest?.files?.[0])
const archive = created.dir
check('archive directory exists', existsSync(archive), existsSync(archive))

// --- 3. status reports age and size ---
const status = backupStatus(backups)
check('status finds the archive', status.latest === archive.split(/[\\/]/u).pop(), status.latest)
check('status reports age and count', status.ageDays >= 0 && status.count === 1, [status.ageDays, status.count])
check('status totals match the manifest', status.totals.files === sources.length, status.totals)

// --- 4. verify re-hashes and passes, then detects tampering ---
const verified = verifyBackup(backups)
check('verify passes on a fresh archive', verified.ok === true && verified.checked === sources.length, [verified.ok, verified.checked])
writeFileSync(join(archive, 'runtime', 'MEMORY.md'), 'tampered\n')
const tampered = verifyBackup(backups)
check('verify detects a modified file', tampered.ok === false && tampered.broken.some((b) => b.label === 'runtime/MEMORY.md'), tampered.broken)
rmSync(join(archive, 'chronicle.jsonl'))
const missing = verifyBackup(backups)
check('verify detects a missing file', missing.ok === false && missing.broken.some((b) => b.label === 'chronicle.jsonl'), missing.broken)

// --- 5. rotation keeps the newest N ---
for (let i = 1; i <= 4; i += 1) {
  createBackup(backups, collected, { now: base + i * 60000, keep: 3 })
}
const afterRotation = backupStatus(backups)
check('rotation keeps the newest archives', afterRotation.count === 3, afterRotation.count)
const prunedDirectly = prune(backups, 2)
check('prune reports what it removed', prunedDirectly.length === 1, prunedDirectly)
check('prune respects the keep bound', backupStatus(backups).count === 2, backupStatus(backups).count)

// --- 6. the tool surface: status / create / verify, never restore ---
{
  const routes = new Map()
  const registered = []
  const ctx = {
    on: () => () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    get(name) {
      if (name === 'config') return { resolveConfigByPackage: () => ({ dataDir: memoryDir }) }
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'tools') return { register: (d) => { registered.push(d); return () => {} } }
      if (name === 'agents') return { list: () => [] }
      if (name === 'tokenMeter') return { contextPressure: () => ({}) }
      if (name === 'schedule') return { list: async () => ({ items: [], total: 0 }) }
      if (name === 'webServer') return {}
      return undefined
    },
    webServer: { register(route) { routes.set(route.path, route); return () => {} } },
    agents: { list: () => [] },
    logger: { warn: () => {} },
  }
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'chron'), backupDir: backups, backupKeep: 2 })
  const tool = registered.find((d) => d.name === 'jarvis_backup')
  check('backup tool is registered', !!tool, registered.map((d) => d.name))
  check('backup tool supports status, create and verify', tool.parameters?.properties?.action?.enum?.join(',') === 'status,create,verify', tool.parameters?.properties?.action)
  const statusValue = await tool.execute({}, {})
  check('tool status reads the archive dir', statusValue.action === 'status' && statusValue.dir === backups, statusValue.dir)
  const rendered = tool.output.render({}, statusValue)[0].text
  check('tool status renders a readable line', rendered.includes('记忆地基'), rendered.slice(0, 30))
  check('tool never offers restore', !JSON.stringify(tool.parameters).includes('restore'), tool.parameters)
}

// --- 6. malformed manifests are reported, never thrown ---
{
  const badDir = join(root, 'bad-manifests')
  mkdirSync(badDir, { recursive: true })
  const archive = join(badDir, 'jarvis-2020-01-01T00-00-00-000')
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ version: 1, files: {} }))
  const notArray = verifyBackup(badDir)
  check('manifest with files:{} is reported', notArray.ok === false && /no files/u.test(notArray.reason || ''), notArray.reason)

  writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ version: 1, files: [] }))
  const emptyFiles = verifyBackup(badDir)
  check('empty files[] is not a false pass', emptyFiles.ok === false && /lists no files/u.test(emptyFiles.reason || ''), emptyFiles.reason)

  writeFileSync(join(archive, 'manifest.json'), JSON.stringify({ version: 1, files: [{ label: 42 }, null, { label: 'ok.md', sha256: 'deadbeef' }] }))
  const badEntries = verifyBackup(badDir)
  check('bad entries become broken rows', badEntries.ok === false && badEntries.checked === 3 && badEntries.broken.length >= 2, [badEntries.checked, badEntries.broken.length])

  writeFileSync(join(archive, 'manifest.json'), '{ not json')
  const brokenJson = verifyBackup(badDir)
  check('invalid JSON is reported', brokenJson.ok === false && /not valid JSON/u.test(brokenJson.reason || ''), brokenJson.reason)

  const missing = verifyBackup(badDir, 'jarvis-1999-01-01T00-00-00-000')
  check('missing archive is reported', missing.ok === false && typeof missing.reason === 'string', missing.reason)
}

// --- 7. backup ids interoperate, same-second archives do not collide ---
{
  const idDir = join(root, 'ids')
  mkdirSync(idDir, { recursive: true })
  const one = createBackup(idDir, collected, { now: base, keep: 5 })
  const byFull = verifyBackup(idDir, one.manifest.id)
  check('verify accepts jarvis-<stamp>', byFull.ok === true, [byFull.ok, byFull.reason])
  const byStamp = verifyBackup(idDir, one.manifest.id.replace(/^jarvis-/u, ''))
  check('verify accepts the bare stamp', byStamp.ok === true, [byStamp.ok, byStamp.reason])

  const sameSecond = createBackup(idDir, collected, { now: base, keep: 5 })
  check('same-millisecond archives get distinct ids', sameSecond.dir !== one.dir, [one.dir, sameSecond.dir])
  check('both archives are listed', backupStatus(idDir).count === 2, backupStatus(idDir).count)
}

// --- 8. memory-space databases and archived runtime files are archived ---
{
  const dbDir = join(root, 'db')
  mkdirSync(join(dbDir, 'runtime'), { recursive: true })
  mkdirSync(join(dbDir, 'documents'), { recursive: true })
  mkdirSync(join(dbDir, 'data', 'space-a'), { recursive: true })
  mkdirSync(join(dbDir, 'runtime', 'archived'), { recursive: true })
  writeFileSync(join(dbDir, 'runtime', 'memories.json'), '{}')
  writeFileSync(join(dbDir, 'data', 'space-a', 'mnemon.db'), Buffer.from('sqlite-bytes'))
  writeFileSync(join(dbDir, 'data', 'space-a', 'mnemon.db-wal'), Buffer.from('wal'))
  writeFileSync(join(dbDir, 'runtime', 'archived', 'old.json'), '{"a":1}')
  const got = collectSources({ memoryRoot: dbDir, chronicleFile: '', personaFile: '', pluginDir: '' })
  const labels = got.sources.map((s) => s.label)
  check('memory-space databases are archived', labels.includes('data/space-a/mnemon.db') && labels.includes('data/space-a/mnemon.db-wal'), labels.filter((l) => l.startsWith('data/')))
  check('archived runtime files are archived', labels.includes('runtime/archived/old.json'), labels.filter((l) => l.startsWith('runtime/archived')))
}

// --- 9. the doctor treats a corrupt archive as degraded, not green ---
{
  const corrupt = join(root, 'corrupt')
  mkdirSync(join(corrupt, 'jarvis-2020-01-01T00-00-00-000'), { recursive: true })
  writeFileSync(join(corrupt, 'jarvis-2020-01-01T00-00-00-000', 'manifest.json'), '{ broken')
  const status = backupStatus(corrupt)
  check('status flags an unreadable manifest', status.ok === false && typeof status.reason === 'string', status.ok)
}
rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
