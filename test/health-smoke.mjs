// Harness for the health instrument under adversarial conditions:
// TTL behaviour, ratio semantics, error-window pruning cost and caps,
// snapshot size discipline, missing/throwing services, and the TDZ window.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const dir = mkdtempSync(join(tmpdir(), 'jarvis-health-'))
mkdirSync(join(dir, 'runtime'), { recursive: true })
mkdirSync(join(dir, 'documents'), { recursive: true })
writeFileSync(join(dir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
  { content: 'health probe', target: 'memory', importance: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
] }))
writeFileSync(join(dir, 'runtime', 'MEMORY.md'), 'M'.repeat(1200))

function makeCtx(options = {}) {
  const routes = new Map()
  const listeners = new Map()
  const calls = { contextPressure: 0, scheduleList: 0, getSchedule: 0, getAgents: 0 }
  const cfg = options.services || {}
  const ctx = {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    effect(execute) {
      if (options.emitBeforeEffect) {
        for (const fn of listeners.get('agent/error') || []) fn({ agent: { id: 'probe' } })
      }
      const dispose = execute()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(name) {
      if (options.hostile) throw new Error('service lookup exploded: ' + name)
      if (name === 'config') return { resolveConfigByPackage: () => ({ dataDir: dir }) }
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'agents') {
        calls.getAgents += 1
        if (cfg.agentsThrows) throw new Error('agents exploded')
        return { list: () => options.agents || [] }
      }
      if (name === 'tokenMeter') {
        return {
          contextPressure(session) {
            calls.contextPressure += 1
            if (cfg.pressureThrows) throw new Error('pressure exploded')
            return options.pressure ? options.pressure(session) : {}
          },
        }
      }
      if (name === 'schedule') {
        calls.getSchedule += 1
        if (!options.schedule) return undefined
        return {
          list: async (request) => {
            calls.scheduleList += 1
            if (options.scheduleRejects) throw new Error('schedule exploded')
            if (options.scheduleNeverSettles) return new Promise(() => {})
            return options.schedule(request)
          },
        }
      }
      return undefined
    },
    webServer: {
      register(route) {
        const key = route.kind + ' ' + route.path
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  return { ctx, routes, listeners, calls }
}

function read(routes) {
  const route = routes.get('exact /dsh-jarvis/state')
  if (!route) return { status: 0, text: '', body: null }
  let payload = ''
  const res = { statusCode: 0, setHeader() {}, end(body) { payload += body } }
  route.handler({ method: 'GET' }, res)
  return { status: res.statusCode, text: payload, body: payload ? JSON.parse(payload) : null }
}

// --- 1. context cache TTL: 300 snapshots must call the meter once ---
{
  const { ctx, routes, calls } = makeCtx({
    agents: [{ session: { id: 'a' } }],
    pressure: () => ({ pressureTokens: 400000, contextWindow: 1000000 }),
  })
  apply(ctx, { nodeCount: 300, chronicle: false })
  for (let i = 0; i < 300; i += 1) read(routes)
  check('context meter is called once per TTL window', calls.contextPressure === 1, calls.contextPressure)
  check('context ratio comes from the busiest session', read(routes).body?.health?.contextRatio === 0.4, read(routes).body?.health?.contextRatio)
}

// --- 2. ratio semantics: clamped, and tokens without a window stay unknown ---
{
  const over = makeCtx({ agents: [{ session: { id: 'a' } }], pressure: () => ({ pressureTokens: 2000000, contextWindow: 1000000 }) })
  apply(over.ctx, { nodeCount: 300, chronicle: false })
  check('context ratio is clamped to 1', read(over.routes).body?.health?.contextRatio === 1, read(over.routes).body?.health?.contextRatio)

  const noWindow = makeCtx({ agents: [{ session: { id: 'a' } }], pressure: () => ({ pressureTokens: 500 }) })
  apply(noWindow.ctx, { nodeCount: 300, chronicle: false })
  const health = read(noWindow.routes).body?.health
  check('missing window reports no ratio', health?.contextRatio === 0 && health?.sessions === 1, [health?.contextRatio, health?.sessions])
}

// --- 3. error window: boundary, cost and cap ---
{
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicle: false })
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const fire = () => {
      for (const fn of listeners.get('agent/error') || []) fn({ agent: { id: 'x' } })
    }
    fire()
    clock += 14 * 60 * 1000 + 59 * 1000
    check('error inside 15 minutes counts', read(routes).body?.health?.recentErrors === 1, read(routes).body?.health?.recentErrors)
    clock += 2000
    check('error older than 15 minutes is pruned', read(routes).body?.health?.recentErrors === 0, read(routes).body?.health?.recentErrors)

    for (let i = 0; i < 50000; i += 1) fire()
    const started = realNow()
    const value = read(routes).body?.health?.recentErrors
    const cost = realNow() - started
    check('error backlog is capped', value <= 4096, value)
    check('reading a huge error backlog stays cheap (<50ms)', cost < 50, cost)
  } finally {
    Date.now = realNow
  }
}

// --- 4. schedule service: rejection keeps the value, absence is not re-probed ---
{
  const missing = makeCtx()
  apply(missing.ctx, { nodeCount: 300, chronicle: false })
  for (let i = 0; i < 300; i += 1) read(missing.routes)
  check('missing schedule service is probed once', missing.calls.getSchedule === 1, missing.calls.getSchedule)

  const rejecting = makeCtx({ schedule: () => ({ items: [], total: 0 }), scheduleRejects: true })
  apply(rejecting.ctx, { nodeCount: 300, chronicle: false })
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('rejected schedule read keeps zero instead of throwing', read(rejecting.routes).body?.health?.schedulesActive === 0, read(rejecting.routes).body?.health?.schedulesActive)
}

// --- 4b. a schedule read that never settles must be retried after 10 s ---
{
  const never = makeCtx({ schedule: () => ({ items: [], total: 0 }), scheduleNeverSettles: true })
  apply(never.ctx, { nodeCount: 300, chronicle: false })
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    read(never.routes)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const first = never.calls.scheduleList
    check('a stuck schedule read is attempted once', first === 1, first)
    clock += 11000
    read(never.routes)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const second = never.calls.scheduleList
    check('a stuck schedule read is retried after the 10 s budget', second === 2, [first, second])
    check('stuck schedule keeps reporting zero tasks', read(never.routes).body?.health?.schedulesActive === 0, read(never.routes).body?.health?.schedulesActive)
  } finally {
    Date.now = realNow
  }
}

// --- 5. snapshot stays small even with a huge persona override ---
{
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, personaText: 'P'.repeat(4096), chronicle: false })
  const text = read(routes).text
  check('persona override does not inflate the snapshot', text.length < 8000, text.length)
  check('persona text is not on the wire', !text.includes('PPPPP'), text.length)
}

// --- 6. hostile host: every service lookup throws ---
{
  const hostile = makeCtx({ hostile: true })
  let threw = null
  try {
    apply(hostile.ctx, { nodeCount: 300, chronicle: false })
  } catch (error) {
    threw = error
  }
  check('apply survives every service lookup throwing', threw === null, threw === null ? null : String(threw.message))
  const state = read(hostile.routes)
  check('state route still answers when services explode', state.status === 200, state.status)
  check('health degrades to zeros', state.body?.health?.contextRatio === 0 && state.body?.health?.schedulesActive === 0, state.body?.health)
}

// --- 7. TDZ window: listeners fire before the effects run ---
{
  const tdz = makeCtx({ emitBeforeEffect: true })
  let threw = null
  try {
    apply(tdz.ctx, { nodeCount: 300, chronicle: false })
  } catch (error) {
    threw = error
  }
  check('errors firing during registration do not break apply', threw === null, threw === null ? null : String(threw.message))
  check('route is registered even after an early error tick', tdz.routes.has('exact /dsh-jarvis/state') === true, [...tdz.routes.keys()])
}

// --- 8. persona: file source, revision tag, overrides and fallback ---
{
  const fromFile = makeCtx()
  apply(fromFile.ctx, { nodeCount: 300, chronicle: false })
  const personaFile = read(fromFile.routes).body?.persona
  check('persona loads from the package file', personaFile?.source === 'file', personaFile?.source)
  check('persona revision tag is a short hex', /^[0-9a-f]{8}$/u.test(String(personaFile?.version || '')), personaFile?.version)
  check('persona reports its length', (personaFile?.chars || 0) > 50, personaFile?.chars)

  const fromConfig = makeCtx()
  apply(fromConfig.ctx, { nodeCount: 300, personaText: 'ZQX 覆盖人格用于测试' , chronicle: false })
  const personaConfig = read(fromConfig.routes).body?.persona
  check('personaText override wins over the file', personaConfig?.source === 'config' && personaConfig?.chars === 12, [personaConfig?.source, personaConfig?.chars])
  check('override changes the revision tag', personaConfig?.version !== personaFile?.version, [personaFile?.version, personaConfig?.version])

  const disabled = makeCtx()
  apply(disabled.ctx, { nodeCount: 300, persona: false , chronicle: false })
  check('persona can be turned off', read(disabled.routes).body?.persona?.active === false, read(disabled.routes).body?.persona?.active)

  const customFile = join(dir, 'custom-persona.md')
  writeFileSync(customFile, '自定义人格文件内容，用于断言来源。')
  const fromCustom = makeCtx()
  apply(fromCustom.ctx, { nodeCount: 300, personaFile: customFile , chronicle: false })
  const personaCustom = read(fromCustom.routes).body?.persona
  check('personaFile overrides the package file', personaCustom?.source === 'file' && personaCustom?.chars === 17, [personaCustom?.source, personaCustom?.chars])
const emptyFile = join(dir, 'empty-persona.md')
  writeFileSync(emptyFile, '   ')
  const fromEmpty = makeCtx()
  apply(fromEmpty.ctx, { nodeCount: 300, personaFile: emptyFile , chronicle: false })
  check('an empty persona file falls back to the package file', read(fromEmpty.routes).body?.persona?.source === 'file', read(fromEmpty.routes).body?.persona?.source)

  const keys = Object.keys(read(fromFile.routes).body?.persona || {}).sort().join(',')
  check('persona snapshot carries exactly five fields', keys === 'active,chars,name,source,version', keys)
  check('persona text never appears in the snapshot', !read(fromFile.routes).text.includes('记忆即人格'), read(fromFile.routes).text.length)
  const missingFile = makeCtx()
  apply(missingFile.ctx, { nodeCount: 300, personaFile: 'C:\\definitely-missing-persona.md' , chronicle: false })
  const personaFallback = read(missingFile.routes).body?.persona
  check('a missing persona file falls back to the package file', personaFallback?.source === 'file' && personaFallback?.chars === 294, [personaFallback?.source, personaFallback?.chars])
}
rmSync(dir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
