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
const sources = collectSources({ memoryRoot: memoryDir, chronicleFile: chronicle, personaFile: join(pluginDir, 'persona.md'), pluginDir })
const labels = sources.map((s) => s.label)
check('collects the runtime store', labels.includes('runtime/memories.json') && labels.includes('runtime/MEMORY.md'), labels)
check('collects document bodies', labels.includes('documents/active/doc-one.md'), labels.filter((l) => l.startsWith('documents/active')))
check('collects chronicle, persona and config', labels.includes('chronicle.jsonl') && labels.includes('persona.md') && labels.includes('plugin/cordis.patch.yml'), labels)

// --- 2. create writes a manifest with hashes ---
const base = Date.now() - 3600_000
const created = createBackup(backups, sources, { now: base, keep: 7 })
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
  createBackup(backups, sources, { now: base + i * 60000, keep: 3 })
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

rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
