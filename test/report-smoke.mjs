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
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [{ content: 'report fixture entry', target: 'memory', importance: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] }))
writeFileSync(join(memoryDir, 'runtime', 'MEMORY.md'), 'M'.repeat(300))
writeFileSync(join(memoryDir, 'runtime', 'USER.md'), 'U'.repeat(20))
const chronicleDir = join(root, 'chronicle')

function makeCtx(options = {}) {
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
      if (name === 'config') return { resolveConfigByPackage: () => ({ dataDir: options.memoryDir || memoryDir }) }
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
      if (name === 'agents') return { list: () => options.agents || [] }
      if (name === 'tokenMeter') return { contextPressure: () => options.pressure || {} }
      if (name === 'schedule') return { list: async () => ({ items: options.scheduleItems || [], total: (options.scheduleItems || []).length }) }
      if (name === 'webServer') return {}
      return undefined
    },
    webServer: {
      register(route) {
        routes.set(route.kind + ' ' + route.path, route)
        return () => {}
      },
    },
    agents: { list: () => options.agents || [] },
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
check('USER ratio is a number, not NaN', /USER\.md \d+%/u.test(body), body.match(/USER\.md [^%]*%/u))
  check('the report counts the memory entries', /- 条目 [1-9]\d*/u.test(body), body.match(/- 条目 .*/u))
  check('the report shows the self-check status', /- 总体 (OK|DEGRADED|FAIL)/u.test(body), body.match(/- 总体 .*/u))
  check('the report shows the backup path', body.includes(join(root, 'b1')), body.includes(join(root, 'b1')))

  // an old chronicle row that recorded a runtime-context snapshot as a label
  // must not appear in the report
  writeFileSync(
    join(chronicleDir, 'chronicle.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), d: created.day, s: 's', u: 'MNEMON 运行时记忆快照 条目注解默认为 importance=normal', tools: 1 }) + '\n',
    { flag: 'a' },
  )
  const withSnapshot = await tool.execute({ day: created.day }, {})
  const snapshotBody = readFileSync(withSnapshot.file, 'utf8')
  check('a runtime-context snapshot is not listed as a turn', !snapshotBody.includes('MNEMON 运行时记忆快照'), snapshotBody.includes('MNEMON 运行时记忆快照'))

  const listed = await tool.execute({ action: 'list' }, {})
  check('list returns the new report', listed.reports.length === 1 && listed.reports[0].day === created.day, listed.reports)
  writeFileSync(created.file, 'MARKER 磁盘原文\n')
  const read = await tool.execute({ action: 'read', day: created.day }, {})
  check('read returns what is on disk, not a regenerated copy', read.body === 'MARKER 磁盘原文\n', read.body)
  // restore a real report for the later checks
  await tool.execute({ day: created.day }, {})
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

// --- 4. a day older than the summary window still reports its real counts ---
{
  const oldDay = '2026-01-05'
  const dir = join(root, 'c4')
  mkdirSync(dir, { recursive: true })
  const rows = []
  for (let i = 0; i < 3; i += 1) {
    rows.push(JSON.stringify({ t: oldDay + 'T03:0' + i + ':00.000Z', d: oldDay, s: 's', u: '历史标签 ' + i, tools: 4 + i }))
  }
  // eight newer days push the old one out of the seven-day summary window
  for (let i = 1; i <= 8; i += 1) {
    rows.push(JSON.stringify({ t: '2026-02-' + String(i).padStart(2, '0') + 'T03:00:00.000Z', d: '2026-02-' + String(i).padStart(2, '0'), s: 's', u: '填充 ' + i, tools: 1 }))
  }
  writeFileSync(join(dir, 'chronicle.jsonl'), rows.join('\n') + '\n')
  const { ctx, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: dir, backupDir: join(root, 'b4'), alerts: false })
  const tool = registered.find((definition) => definition.name === 'jarvis_report')
  const made = await tool.execute({ day: oldDay }, {})
  const body = readFileSync(made.file, 'utf8')
  check('an old day keeps its real turn count', /- 轮次 3 · 工具 15/u.test(body), body.match(/- 轮次 .*/u))
  check('an old day keeps its labels', body.includes('历史标签 2'), body.includes('历史标签 2'))
}

// --- 5. invalid days are refused, not turned into filenames ---
{
  const dir = join(root, 'c5')
  const { ctx, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: dir, backupDir: join(root, 'b5'), alerts: false })
  const tool = registered.find((definition) => definition.name === 'jarvis_report')
  for (const bad of ['2026-13-45', 'not-a-date']) {
    const refused = await tool.execute({ day: bad }, {})
    check('an invalid day is refused (' + bad + ')', refused.ok === false && /day/u.test(refused.reason), refused)
  }
  check('an invalid day writes no file', !existsSync(join(dir, 'reports')), existsSync(join(dir, 'reports')))
}

// --- 6. read works past the list window and reports a missing day ---
{
  const dir = join(root, 'c6')
  mkdirSync(join(dir, 'reports'), { recursive: true })
  for (let i = 1; i <= 31; i += 1) {
    const day = '2026-02-' + String(i).padStart(2, '0')
    writeFileSync(join(dir, 'reports', day + '.md'), 'REPORT ' + day + '\n')
  }
  const { ctx, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: dir, backupDir: join(root, 'b6'), alerts: false })
  const tool = registered.find((definition) => definition.name === 'jarvis_report')
  const read = await tool.execute({ action: 'read', day: '2026-02-01' }, {})
  check('read reaches a report outside the list window', read.body === 'REPORT 2026-02-01\n', read.body)
  const missing = await tool.execute({ action: 'read', day: '2026-03-01' }, {})
  check('read reports a missing day with a reason', missing.body === '' && /no report/u.test(missing.reason || ''), missing)
  const bad = await tool.execute({ action: 'read', day: 'nope' }, {})
  check('read refuses an invalid day', bad.ok === false, bad)
}
// --- 7. more alerts than the visible slots are still reported ---
{
  const dir = join(root, 'c7')
  const heavy = join(root, 'c7-heavy')
  mkdirSync(join(heavy, 'runtime'), { recursive: true })
  writeFileSync(join(heavy, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))
  writeFileSync(join(heavy, 'runtime', 'MEMORY.md'), 'M'.repeat(9800))
  const soon = new Date(Date.now() + 10 * 60000).toISOString()
  const { ctx, routes, registered, listeners } = makeCtx({
    agents: [{ session: { id: 's' } }],
    pressure: { pressureTokens: 950, contextWindow: 1000 },
    scheduleItems: [{ scheduledAt: soon, title: 'due' }],
  })
  apply(ctx, { nodeCount: 300, memoryDir: heavy, memoryDirs: [heavy], chronicleDir: dir, backupDir: join(root, 'missing-backups-7'), alerts: true, recap: false })
  for (let i = 0; i < 3; i += 1) {
    for (const fn of listeners.get('agent/error') || []) fn({ agent: { id: 's1' }, turn: 1, step: 1, error: new Error('boom') })
  }
  // let the schedule read settle so the due alert exists before the report
  state(routes)
  await new Promise((resolve) => setTimeout(resolve, 40))
  const tool = registered.find((definition) => definition.name === 'jarvis_report')
  const made = await tool.execute({}, {})
  const body = readFileSync(made.file, 'utf8')
  check('a report with five alerts mentions the remainder', /另有 \d+ 条/u.test(body), body.match(/- 另有 .*/u))
}
rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
