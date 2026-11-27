// Harness for proactive alerts: thresholds become prompt context, an ack mutes
// a standing problem until it clears, and the snapshot stays small.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-alerts-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))
const chronicleDir = join(root, 'chronicle')

function makeCtx(options = {}) {
  const routes = new Map()
  const listeners = new Map()
  const registered = []
  const contexts = []
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
      if (name === 'systemPrompt') {
        return {
          section: () => () => {},
          context: (contribution) => {
            contexts.push(contribution)
            return () => {
              const at = contexts.indexOf(contribution)
              if (at >= 0) contexts.splice(at, 1)
            }
          },
        }
      }
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
      if (name === 'agents') return { list: () => options.agents || [{ session: { id: 'session-alert' } }] }
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
  return { ctx, routes, registered, contexts, listeners }
}

function emit(listeners, name, payload) {
  for (const fn of listeners.get(name) || []) fn(payload)
}

function state(routes) {
  const route = routes.get('exact /dsh-jarvis/state')
  let payload = ''
  route.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(body) { payload += body } })
  return JSON.parse(payload)
}

function alertContext(contexts) {
  return contexts.find((entry) => entry.name === 'jarvis:alerts')
}

// --- 1. a healthy host has no noise ---
{
  const { ctx, routes, contexts } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'backups'), alerts: false })
  const snapshot = state(routes).alerts
  check('a healthy host has no alerts', snapshot?.count === 0, snapshot)
  check('alerts can be turned off entirely', !alertContext(contexts), contexts.map((c) => c.name))
}

// --- 2. thresholds fire and reach the prompt context ---
{
  const soon = new Date(Date.now() + 10 * 60000).toISOString()
  const { ctx, routes, contexts, registered, listeners } = makeCtx({
    pressure: { pressureTokens: 900, contextWindow: 1000 },
    scheduleItems: [{ scheduledAt: soon, title: 'due soon' }],
  })
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'missing-backups'), alerts: true })
  check('the alert context is registered', !!alertContext(contexts), contexts.map((c) => c.name))
  state(routes)
  await new Promise((resolve) => setTimeout(resolve, 30))
  for (let i = 0; i < 3; i += 1) emit(listeners, 'agent/error', { agent: { id: 's1' }, turn: 1, step: 1, error: new Error('boom') })

  const snapshot = state(routes).alerts
  const ids = (snapshot?.active || []).map((alert) => alert.id)
  check('context pressure raises an alert', ids.includes('context'), ids)
  check('a due task raises an alert', ids.includes('due'), ids)
  check('a missing backup raises an alert', ids.includes('backup'), ids)
  check('repeated errors raise an alert', ids.includes('errors'), ids)
  check('the snapshot stays small', JSON.stringify(snapshot).length < 600, JSON.stringify(snapshot).length)

  const text = alertContext(contexts).text({})
  check('the prompt context lists alerts', text.includes('JARVIS 提醒') && text.includes('上下文压力'), text)
  check('the context is capped at four', text.split('\n').length <= 5, text.split('\n').length)

  const tool = registered.find((definition) => definition.name === 'jarvis_alerts')
  check('the alert tool is registered', !!tool, registered.map((d) => d.name))
  const listed = await tool.execute({}, {})
  check('the tool lists the alerts', listed.alerts.count > 0, listed.alerts)
  const acked = await tool.execute({ action: 'ack' }, {})
  check('acknowledging reports the ids', Array.isArray(acked.acked) && acked.acked.length > 0 && Array.isArray(acked.ignored), acked)
  check('acknowledged alerts leave the snapshot', state(routes).alerts.count === 0, state(routes).alerts)
  check('acknowledged alerts leave the prompt', alertContext(contexts).text({}) === '', alertContext(contexts).text({}))

  // a standing condition must not reappear immediately
  state(routes)
  check('a standing condition honours the cooldown', state(routes).alerts.count === 0, state(routes).alerts)
}

// --- 3. ack holds while the condition stands, and revival needs the cooldown ---
{
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const options = { pressure: { pressureTokens: 950, contextWindow: 1000 } }
    const { ctx, routes, contexts, registered } = makeCtx(options)
    apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'backups-3'), alerts: true })
    const alertTool = registered.find((definition) => definition.name === 'jarvis_alerts')
    const before = state(routes).alerts
    check('context alert fires', (before.active || []).some((alert) => alert.id === 'context'), before)
    check('the prompt text is not empty while an alert is active', alertContext(contexts).text({}).length > 0, alertContext(contexts).text({}))

    // acknowledge on this same instance, then hold the condition
    const acked = await alertTool.execute({ action: 'ack' }, {})
    check('ack reports the cleared ids', Array.isArray(acked.acked) && acked.acked.length > 0, acked)
    clock += 10 * 60000
    const during = state(routes).alerts
    check('an acked condition stays silent while it stands', !(during.active || []).some((alert) => alert.id === 'context'), during)

    // the condition clears: the acknowledgement must be released with it
    // (contextHealth caches for 2 s, so step past that cache to observe it)
    options.pressure = {}
    clock += 10 * 1000
    state(routes)
    check('a cleared condition drops its acknowledgement', !(state(routes).alerts.active || []).some((alert) => alert.id === 'context'), state(routes).alerts)
    clock += 25 * 60000
    options.pressure = { pressureTokens: 950, contextWindow: 1000 }
    const suppressed = state(routes).alerts
    check('a returning condition is suppressed inside the cooldown', !(suppressed.active || []).some((alert) => alert.id === 'context'), suppressed)

    // the cooldown is anchored on the retirement moment: 31 minutes after it
    clock += 6 * 60000
    const revived = state(routes).alerts
    check('a returning condition alerts again after the cooldown', (revived.active || []).some((alert) => alert.id === 'context'), revived)

    // a string id is a single target, never "everything"
    const single = await alertTool.execute({ action: 'ack', ids: 'context' }, {})
    check('a string id acknowledges only that alert', single.acked.length === 1 && single.acked[0] === 'context', single)
  } finally {
    Date.now = realNow
  }
}

// --- 3b. id shapes: unknown and malformed ids never acknowledge everything ---
{
  const { ctx, routes, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'no-backups-3b'), alerts: true })
  const tool = registered.find((definition) => definition.name === 'jarvis_alerts')
  const before = state(routes).alerts
  check('a backup alert is active for the id checks', before.count >= 1, before)
  const unknown = await tool.execute({ action: 'ack', ids: ['nope'] }, {})
  check('unknown ids are ignored and reported', unknown.acked.length === 0 && unknown.ignored.includes('nope'), unknown)
  check('an unknown id leaves the real alerts alone', state(routes).alerts.count === before.count, [before.count, state(routes).alerts.count])
  const guard = await tool.execute({ action: 'ack', ids: { all: true } }, {})
  check('a non-array ids value acknowledges nothing', guard.acked.length === 0, guard)
  check('a rejected ids value leaves alerts in place', state(routes).alerts.count === before.count, state(routes).alerts)
}
// --- 3c. acknowledging before anything reads the snapshot must still work ---
{
  const { ctx, routes, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'no-backups-3c'), alerts: true })
  const tool = registered.find((definition) => definition.name === 'jarvis_alerts')
  const acked = await tool.execute({ action: 'ack' }, {})
  check('ack works before any snapshot read', Array.isArray(acked.acked) && acked.acked.length >= 1, acked)
  check('a cold ack leaves nothing active', state(routes).alerts.count === 0, state(routes).alerts)
}
// --- 4. six conditions: count is honest, the urgent ones stay visible ---
{
  const soon = new Date(Date.now() + 20 * 60000).toISOString()
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'x')
  writeFileSync(join(memoryDir, 'runtime', 'MEMORY.md'), 'M'.repeat(9600))
  const { ctx, routes, contexts, registered, listeners } = makeCtx({
    pressure: { pressureTokens: 950, contextWindow: 1000 },
    scheduleItems: [{ scheduledAt: soon, title: 'due soon' }],
    memoryEntries: 93,
  })
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(blocker, 'nested'), backupDir: join(root, 'no-backups'), alerts: true })
  state(routes)
  await new Promise((resolve) => setTimeout(resolve, 30))
  for (let i = 0; i < 3; i += 1) emit(listeners, 'agent/error', { agent: { id: 's1' }, turn: 1, step: 1, error: new Error('boom') })

  const snapshot = state(routes).alerts
  const ids = (snapshot.active || []).map((alert) => alert.id)
  check('six conditions are all counted', snapshot.count === 6, [snapshot.count, ids])
  check('only four are shown', snapshot.active.length === 4, snapshot.active.length)
  check('errors and due survive the cap', ids.includes('errors') && ids.includes('due'), ids)
  check('a failing self-check survives the cap', ids.includes('doctor'), ids)
  const text = alertContext(contexts).text({})
  check('the prompt reports the hidden alerts', /另有 2 条提醒/u.test(text), text)

  const tool = registered.find((definition) => definition.name === 'jarvis_alerts')
  const listed = await tool.execute({}, {})
  check('the tool lists every alert', listed.alerts.count === 6 && listed.alerts.active.length === 6, [listed.alerts.count, listed.alerts.active.length])
}
// --- 5. alerts: false leaves no context but the snapshot stays valid ---

{
  const { ctx, routes, contexts, registered } = makeCtx({ pressure: { pressureTokens: 950, contextWindow: 1000 } })
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, alerts: false })
  check('no context is registered when alerts are off', !alertContext(contexts), contexts.map((c) => c.name))
  check('no alert tool is registered when alerts are off', !registered.some((d) => d.name === 'jarvis_alerts'), registered.map((d) => d.name))
  const snapshot = state(routes).alerts
  check('the snapshot keeps a valid shape when alerts are off', snapshot && snapshot.count === 0, snapshot)
}

rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)