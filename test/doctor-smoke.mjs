// Harness for the self-check: a healthy host reports ok, a broken host reports
// degraded or fail with a concrete fix, and the report never throws.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-doctor-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
  { content: 'doctor probe entry', target: 'memory', importance: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
] }))
writeFileSync(join(memoryDir, 'runtime', 'MEMORY.md'), 'M'.repeat(200))
const chronicleDir = join(root, 'chronicle')
mkdirSync(chronicleDir, { recursive: true })

function makeCtx(options = {}) {
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
      if (options.noServices) {
        if (name === 'webServer') return undefined
        return undefined
      }
      if (name === 'config') return { resolveConfigByPackage: () => ({ dataDir: options.memoryDir || memoryDir }) }
      if (name === 'systemPrompt') return options.noPrompt ? undefined : { section: () => () => {}, context: () => () => {} }
      if (name === 'tools') {
        if (options.noTools) return undefined
        if (options.toolsThrow) {
          return {
            register(definition) {
              if (options.toolsThrow === 'all' || options.toolsThrow === definition.name) throw new Error('register refused')
              registered.push(definition)
              return () => {}
            },
          }
        }
        return {
          register(definition) {
            registered.push(definition)
            return () => {}
          },
        }
      }
      if (name === 'webServer') return options.noServices ? undefined : { register: () => () => {} }
      if (name === 'agents') return options.noAgents ? undefined : { list: () => [] }
      if (name === 'tokenMeter') return { contextPressure: () => ({}) }
      if (name === 'schedule') return options.noSchedule ? undefined : { list: async () => ({ items: [], total: 0 }) }
      return undefined
    },
    webServer: options.noWebServer
      ? { register() { throw new Error('webServer exploded') } }
      : {
          register(route) {
            routes.set(route.kind + ' ' + route.path, route)
            return () => routes.delete(route.kind + ' ' + route.path)
          },
        },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  return { ctx, routes, registered }
}

function state(routes) {
  const route = routes.get('exact /dsh-jarvis/state')
  if (!route) return null
  let payload = ''
  route.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(body) { payload += body } })
  return JSON.parse(payload)
}

function byId(report, id) {
  return (report && Array.isArray(report.checks) ? report.checks.find((entry) => entry.id === id) : undefined)
}

// --- 1. a healthy host reports ok everywhere and the doctor renders ---
{
  const { ctx, routes, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, chronicle: true, backup: false })
  const report = state(routes)?.diagnostics
  check('diagnostics are in the snapshot', !!report && Array.isArray(report.checks), report?.checks?.length)
  check('healthy host reports ok', report?.status === 'ok', report?.status)
  check('every check carries id + status + detail', report.checks.every((c) => c.id && c.status && c.detail), report.checks.map((c) => c.id))
  check('the thirteen expected checks are present', ['route', 'persona', 'memory', 'chronicle', 'services', 'caches', 'tools', 'shell', 'layout', 'shape', 'detail', 'scene', 'backup'].every((id) => byId(report, id)), report.checks.map((c) => c.id))
  check('route check names the served path', /\/dsh-jarvis\/state/u.test(byId(report, 'route')?.detail || ''), byId(report, 'route')?.detail)

  const doctor = registered.find((definition) => definition.name === 'jarvis_doctor')
  check('doctor tool is registered', !!doctor, registered.map((d) => d.name))
  const value = await doctor.execute({}, {})
  check('doctor execute returns the report', value?.status === 'ok', value?.status)
  const rendered = doctor.output.render({}, value)[0].text
  check('doctor renders a readable report', rendered.includes('JARVIS 自检') && rendered.includes('[OK] route'), rendered.slice(0, 40))
  check('healthy report has no fix lines', !rendered.includes('修法：'), rendered.length)
}

// --- 2. a missing persona service degrades the persona check only ---
{
  const { ctx, routes } = makeCtx({ noPrompt: true })
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir })
  const report = state(routes)?.diagnostics
  check('missing systemPrompt degrades persona', byId(report, 'persona')?.status === 'degraded', byId(report, 'persona'))
  check('a missing systemPrompt also degrades tools (alert context)', byId(report, 'tools')?.status === 'degraded' && /alerts missing/u.test(byId(report, 'tools')?.detail || ''), byId(report, 'tools'))
  check('overall status degrades', report?.status === 'degraded', report?.status)
  const doctorAdvice = (() => {
    const { ctx: c2, registered: r2 } = makeCtx({ noPrompt: true })
    apply(c2, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir })
    const doctor = r2.find((definition) => definition.name === 'jarvis_doctor')
    return doctor.output.render({}, { status: 'degraded', checks: [{ id: 'persona', status: 'degraded', detail: 'x' }] })[0].text
  })()
  check('degraded checks carry a fix line', doctorAdvice.includes('修法：'), doctorAdvice.length)
}

// --- 3. an unwritable chronicle directory fails its check ---
{
  const blocker = join(root, 'not-a-dir')
  writeFileSync(blocker, 'x')
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(blocker, 'nested') })
  const report = state(routes)?.diagnostics
  check('unwritable chronicle dir fails', byId(report, 'chronicle')?.status === 'fail', byId(report, 'chronicle'))
  check('overall status is fail', report?.status === 'fail', report?.status)
}

// --- 4. a host without services fails the services check without throwing ---
{
  const { ctx, routes } = makeCtx({ noServices: true })
  let threw = null
  try {
    apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir })
  } catch (error) {
    threw = error
  }
  check('apply survives a host with no services', threw === null, threw === null ? null : String(threw.message))
  const report = state(routes)?.diagnostics
  check('services check fails when every service is absent', byId(report, 'services')?.status === 'fail', byId(report, 'services'))
}

// --- 5. the report is cached: repeated snapshots do not re-probe ---
{
  let probes = 0
  const { ctx, routes } = makeCtx()
  const realGet = ctx.get
  ctx.get = (name) => {
    if (name === 'schedule') probes += 1
    return realGet(name)
  }
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir })
  await new Promise((resolve) => setTimeout(resolve, 30))
  for (let i = 0; i < 200; i += 1) state(routes)
  check('diagnostics probe services once per cache window', probes <= 2, probes)
}

// --- 6. a not-yet-created chronicle directory is degraded, never created ---
{
  const freshDir = join(root, 'fresh-chronicle')
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: freshDir })
  const report = state(routes)?.diagnostics
  check('missing chronicle dir is degraded, not created', byId(report, 'chronicle')?.status === 'degraded', byId(report, 'chronicle'))
  check('diagnostics never create the directory', !existsSync(freshDir), existsSync(freshDir))
}

// --- 7. a refused tool registration is reported as missing, not as on ---
{
  const { ctx, routes } = makeCtx({ toolsThrow: 'all' })
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir })
  const report = state(routes)?.diagnostics
  check('all tools refused reports fail', byId(report, 'tools')?.status === 'fail', byId(report, 'tools'))
  check('refused tools are named as missing', /keeper missing · chronicle missing · doctor missing/u.test(byId(report, 'tools')?.detail || ''), byId(report, 'tools')?.detail)

  const partial = makeCtx({ toolsThrow: 'jarvis_doctor' })
  apply(partial.ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir })
  const partialReport = state(partial.routes)?.diagnostics
  check('one refused tool reports degraded', byId(partialReport, 'tools')?.status === 'degraded', byId(partialReport, 'tools'))
  check('the refused tool is named', /doctor missing/u.test(byId(partialReport, 'tools')?.detail || ''), byId(partialReport, 'tools')?.detail)
}
// --- 8. an empty backup directory is degraded until the first archive ---
{
  const emptyBackups = join(root, 'no-backups-yet')
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: emptyBackups })
  const report = state(routes)?.diagnostics
  check('missing archive degrades the backup channel', byId(report, 'backup')?.status === 'degraded', byId(report, 'backup'))
  check('backup advice names the action', /jarvis_backup create/u.test(byId(report, 'backup')?.detail || ''), byId(report, 'backup')?.detail)
}
// --- 9. backup channel: age boundaries and a corrupt manifest ---
{
  const { createBackup, collectSources } = await import('../backup.js')
  const archiveRoot = join(root, 'age-backups')
  mkdirSync(archiveRoot, { recursive: true })
  const collected = collectSources({ memoryRoot: memoryDir, chronicleFile: '', personaFile: '', pluginDir: '' })

  // exactly 14 days old is still ok; 15 days degrades
  createBackup(archiveRoot, collected, { now: Date.now() - 14 * 86400000, keep: 5 })
  const boundary = makeCtx()
  apply(boundary.ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: archiveRoot })
  check('a 14-day-old archive is still ok', byId(state(boundary.routes)?.diagnostics, 'backup')?.status === 'ok', byId(state(boundary.routes)?.diagnostics, 'backup'))

  const olderRoot = join(root, 'older-backups')
  mkdirSync(olderRoot, { recursive: true })
  createBackup(olderRoot, collected, { now: Date.now() - 15 * 86400000, keep: 5 })
  const stale = makeCtx()
  apply(stale.ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: olderRoot })
  check('a 15-day-old archive degrades', byId(state(stale.routes)?.diagnostics, 'backup')?.status === 'degraded', byId(state(stale.routes)?.diagnostics, 'backup'))

  // a corrupt manifest must never read as green
  const corruptRoot = join(root, 'corrupt-backups')
  mkdirSync(join(corruptRoot, 'jarvis-2020-01-01T00-00-00-000'), { recursive: true })
  writeFileSync(join(corruptRoot, 'jarvis-2020-01-01T00-00-00-000', 'manifest.json'), '{ nope')
  const corrupt = makeCtx()
  apply(corrupt.ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: corruptRoot })
  const corruptCheck = byId(state(corrupt.routes)?.diagnostics, 'backup')
  check('a corrupt manifest degrades the backup channel', corruptCheck?.status === 'degraded', corruptCheck)
  check('the degradation names the reason', /unreadable/u.test(corruptCheck?.detail || ''), corruptCheck?.detail)
}
// --- 10. a partial archive is not green either ---
{
  const { createBackup, collectSources } = await import('../backup.js')
  const partialRoot = join(root, 'partial-backups')
  mkdirSync(partialRoot, { recursive: true })
  const collected = collectSources({ memoryRoot: memoryDir, chronicleFile: '', personaFile: '', pluginDir: '' })
  const made = createBackup(partialRoot, collected, { now: Date.now() - 3600000, keep: 5 })
  const manifestPath = join(made.dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.truncated = ['documents/active (first 500 of 501+)']
  manifest.totals.truncated = true
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  const partial = makeCtx()
  apply(partial.ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: partialRoot })
  const partialCheck = byId(state(partial.routes)?.diagnostics, 'backup')
  check('a truncated archive degrades the backup channel', partialCheck?.status === 'degraded', partialCheck)
  check('the report names what was capped', /partial|truncated|limits hit/u.test(partialCheck?.detail || ''), partialCheck?.detail)
}
rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
