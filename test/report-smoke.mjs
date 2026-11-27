// Harness for the daily report: Markdown with the day's work, memory fill,
// self-check, backup and alerts; never touches memory.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-report-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))
writeFileSync(join(memoryDir, 'runtime', 'MEMORY.md'), 'M'.repeat(300))
writeFileSync(join(memoryDir, 'runtime', 'USER.md'), 'U'.repeat(20))
const chronicleDir = join(root, 'chronicle')

function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const registered = []
  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
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
    webServer: {
      register(route) {
        routes.set(route.kind + ' ' + route.path, route)
        return () => {}
      },
    },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  return { ctx, routes, registered, listeners }
}

function emit(listeners, session, event) {
  for (const fn of listeners.get('session/event') || []) fn(session, event)
}

function state(routes) {
  const route = routes.get('exact /dsh-jarvis/state')
  let payload = ''
  route.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(body) { payload += body } })
  return JSON.parse(payload)
}

function sessionWith(text) {
  return { deriveMessages() { return [{ role: 'user', content: [{ type: 'text', text }] }] } }
}

// --- 1. the report is written with every section ---
{
  const { ctx, routes, listeners, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'b1'), alerts: true })
  // one finished turn so the report has work to show
  emit(listeners, sessionWith('把球体 HUD 改成中文'), { type: 'step/start', data: { turn: 1, step: 1 } })
  emit(listeners, sessionWith('把球体 HUD 改成中文'), { type: 'turn/end', data: { turn: 1 } })

  const tool = registered.find((definition) => definition.name === 'jarvis_report')
  check('the report tool is registered', !!tool, registered.map((d) => d.name))
  const created = await tool.execute({}, {})
  check('create writes a file', created.ok === true && existsSync(created.file), created)
  check('the file lands under reports/', created.file.includes(join('reports', '')) || created.file.includes('reports'), created.file)

  const body = readFileSync(created.file, 'utf8')
  check('the report names the day', /^# JARVIS 日报 · \d{4}-\d{2}-\d{2}/u.test(body), body.split('\n')[0])
  for (const section of ['今天做了什么', '记忆', '自检', '备份', '提醒']) {
    check('the report has ## ' + section, new RegExp('^## ' + section + '$', 'mu').test(body), section)
  }
  check('the report shows the turn label', body.includes('把球体 HUD 改成中文'), body.includes('把球体 HUD 改成中文'))
  check('the report shows the self-check status', /- 总体 (OK|DEGRADED|FAIL)/u.test(body), body.match(/- 总体 .*/u))
  check('the report shows the backup path', body.includes(join(root, 'b1')), body.includes(join(root, 'b1')))

  const listed = await tool.execute({ action: 'list' }, {})
  check('list returns the new report', listed.reports.length === 1 && listed.reports[0].day === created.day, listed.reports)
  const read = await tool.execute({ action: 'read', day: created.day }, {})
  check('read returns the same content', read.body.includes('## 自检'), read.body.slice(0, 40))
  const missing = await tool.execute({ action: 'read', day: '2001-01-01' }, {})
  check('reading a missing day reports a reason', missing.reason === 'no report for 2001-01-01', missing)
}

// --- 2. a second day does not overwrite the first ---
{
  const { ctx, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c2'), backupDir: join(root, 'b2'), alerts: false })
  const tool = registered.find((definition) => definition.name === 'jarvis_report')
  await tool.execute({ day: '2026-01-01' }, {})
  await tool.execute({ day: '2026-01-02' }, {})
  const files = readdirSync(join(root, 'c2', 'reports')).sort()
  check('two days produce two files', files.length === 2 && files[0] === '2026-01-01.md', files)
}

// --- 3. report: false disables the tool ---
{
  const { ctx, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c3'), backupDir: join(root, 'b3'), report: false })
  check('report off registers no tool', !registered.some((d) => d.name === 'jarvis_report'), registered.map((d) => d.name))
}

rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
