// Harness for the memory projection and the persona section.
//
// Two scenarios: whatever Mnemon store this machine has, and a synthetic store
// with 5,000 entries plus 300 documents that proves the projection is bounded
// by hash slots instead of by entry count (no truncation, no payload growth).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { apply, __test } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

function makeCtx(dataDir) {
  const routes = new Map()
  const sections = []
  const effects = []
  const ctx = {
    on() {
      return () => {}
    },
    effect(execute) {
      const dispose = execute()
      effects.push(typeof dispose === 'function' ? dispose : () => {})
      return effects[effects.length - 1]
    },
    get(name) {
      if (name === 'config') {
        return {
          resolveConfigByPackage(pkg) {
            return pkg === 'dsh-mnemon' ? { dataDir } : undefined
          },
        }
      }
      if (name === 'systemPrompt') {
        return {
          section(section) {
            sections.push(section)
            return () => {
              const at = sections.indexOf(section)
              if (at >= 0) sections.splice(at, 1)
            }
          },
        }
      }
      return undefined
    },
    webServer: {
      register(route) {
        const key = route.kind + ' ' + route.path
        if (routes.has(key)) throw new Error('duplicate route')
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
    agents: { list: () => [] },
    logger: { warn(message) { console.log('LOG', message) } },
  }
  return { ctx, routes, sections, effects }
}

function readState(routes) {
  const route = routes.get('exact /dsh-jarvis/state')
  if (!route) return { status: 0, text: '' }
  let payload = ''
  const res = { statusCode: 0, setHeader() {}, end(body) { payload += body } }
  route.handler({ method: 'GET' }, res)
  return { status: res.statusCode, text: payload, body: payload ? JSON.parse(payload) : null }
}

// ---- scenario 1: a synthetic store far past the old 120-node cap ----
const started = Date.now()
const bigDir = mkdtempSync(join(tmpdir(), 'jarvis-mem-'))
mkdirSync(join(bigDir, 'runtime'), { recursive: true })
mkdirSync(join(bigDir, 'documents'), { recursive: true })
mkdirSync(join(bigDir, 'data'), { recursive: true })
const entries = []
for (let i = 0; i < 5000; i += 1) {
  entries.push({
    content: 'synthetic memory entry number ' + String(i),
    target: i % 5 === 0 ? 'user' : 'memory',
    importance: i % 17 === 0 ? 'critical' : i % 3 === 0 ? 'low' : 'normal',
    created_at: new Date(Date.now() - i * 3600_000).toISOString(),
    updated_at: new Date(Date.now() - i * 3600_000).toISOString(),
  })
}
writeFileSync(join(bigDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries }))
const docs = []
for (let i = 0; i < 300; i += 1) {
  docs.push({ id: 'doc-' + String(i), title: 'Private title ' + String(i), filename: 'secret-' + String(i) + '.md', updatedAt: new Date().toISOString() })
}
writeFileSync(join(bigDir, 'documents', 'index.json'), JSON.stringify({ version: 1, documents: docs }))
writeFileSync(join(bigDir, 'data', '.dsh-memory-bodies.json'), JSON.stringify({ version: 1, bodies: [{ id: 'space-a', name: 'A', active: true }] }))

{
  const { ctx, routes, sections, effects } = makeCtx(bigDir)
  apply(ctx, { nodeCount: 460, memorySlots: 0 })
  const state = readState(routes)
  const memory = state.body?.memory
  check('big store: all 5,000 entries counted', memory?.total === 5000, memory?.total)
  check('big store: documents counted', memory?.documents === 300, memory?.documents)
  check('big store: slots bounded by nodeCount', Array.isArray(memory?.slots) && memory.slots.length <= 460, memory?.slots?.length)
  check('big store: slots cluster (n > 1)', (memory?.slots || []).some((s) => s.n > 1), (memory?.slots || []).map((s) => s.n).sort((a, b) => b - a).slice(0, 3))
  check('big store: payload stays small', state.text.length < 60000, state.text.length)
  check('big store: 96 document ticks', memory?.docTicks?.length === 96, memory?.docTicks?.length)
  check('big store: ticks cover every document', memory?.docTicks?.reduce((a, b) => a + b, 0) === 300, memory?.docTicks?.reduce((a, b) => a + b, 0))
  check('big store: no entry text on the wire', !state.text.includes('synthetic memory entry'), state.text.length)
  check('big store: no document titles on the wire', !state.text.includes('Private title') && !state.text.includes('secret-'), state.text.length)
  check('persona section registered', sections.length === 1 && sections[0]?.name === 'jarvis:persona', sections[0]?.name)
  check('persona text present', /JARVIS/.test(String(sections[0]?.text || '')), String(sections[0]?.text || '').slice(0, 16))
  for (const release of effects.splice(0)) release()
  check('unload removes the route', routes.size === 0, routes.size)
  check('unload removes the persona', sections.length === 0, sections.length)
  console.log('synthetic scenario took', Date.now() - started, 'ms')
}
rmSync(bigDir, { recursive: true, force: true })

// ---- scenario 2: store discovery (a stale default must not shadow the live store) ----
{
  const staleDir = mkdtempSync(join(tmpdir(), 'jarvis-stale-'))
  const liveDir = mkdtempSync(join(tmpdir(), 'jarvis-live-'))
  for (const [dir, count, ageMs] of [[staleDir, 2, 7200_000], [liveDir, 14, 0]]) {
    mkdirSync(join(dir, 'runtime'), { recursive: true })
    const list = []
    for (let i = 0; i < count; i += 1) {
      const at = new Date(Date.now() - ageMs).toISOString()
      list.push({ content: 'entry ' + String(i) + ' of ' + dir, target: 'memory', importance: 'normal', created_at: at, updated_at: at })
    }
    const file = join(dir, 'runtime', 'memories.json')
    writeFileSync(file, JSON.stringify({ version: 1, entries: list }))
    const stamp = new Date(Date.now() - ageMs)
    utimesSync(file, stamp, stamp)
  }
  check('config refs are unwrapped', __test.configValue({ get: () => 'X' }) === 'X' && __test.configValue('Y') === 'Y', [__test.configValue({ get: () => 'X' }), __test.configValue('Y')])
  check('newest store wins by default', __test.pickMemoryRoot([staleDir, liveDir], []).root === liveDir, __test.pickMemoryRoot([staleDir, liveDir], []).root === liveDir)
  check('explicit memoryDirs wins', __test.pickMemoryRoot([staleDir, liveDir], [staleDir]).root === staleDir, __test.pickMemoryRoot([staleDir, liveDir], [staleDir]).root === staleDir)

  const { ctx, routes } = makeCtx(liveDir)
  apply(ctx, { memoryDirs: [liveDir], chronicle: false })
  check('explicit root is the one projected', readState(routes).body?.memory?.total === 14, readState(routes).body?.memory?.total)
  rmSync(staleDir, { recursive: true, force: true })
  rmSync(liveDir, { recursive: true, force: true })
}

// ---- scenario 3: this machine's real store, when it exists ----
const candidates = [process.env.DSH_MNEMON_DATA_DIR, 'D:\\AI\\记忆数据', join(homedir(), '.mnemon')].filter(Boolean)
const realDir = candidates.find((dir) => existsSync(join(dir, 'runtime', 'memories.json')))
if (realDir) {
  const { ctx, routes } = makeCtx(realDir)
  apply(ctx, { nodeCount: 460, chronicle: false })
  const state = readState(routes)
  const memory = state.body?.memory
  check('real store: projection ok', memory?.ok === true, memory?.ok)
  check('real store: totals add up', memory?.total === (memory?.user || 0) + (memory?.memory || 0), [memory?.total, memory?.user, memory?.memory])
  check('real store: slots present', Array.isArray(memory?.slots) && memory.slots.length > 0, memory?.slots?.length)
  check('real store: slots carry no text', Object.keys(memory?.slots?.[0] || {}).sort().join(',') === 'a,f,i,n,s,t', Object.keys(memory?.slots?.[0] || {}).sort().join(','))
  check('health reports memory pressure', typeof state.body?.health?.memoryRatio === 'number' && state.body.health.memoryRatio >= 0, state.body?.health)
  check('health carries the limit', typeof state.body?.health?.memoryLimitBytes === 'number' && state.body.health.memoryLimitBytes > 0, state.body?.health?.memoryLimitBytes)
  check('health reports context pressure', typeof state.body?.health?.contextRatio === 'number', state.body?.health?.contextRatio)
  check('health reports scheduled tasks', typeof state.body?.health?.schedulesActive === 'number', state.body?.health?.schedulesActive)
  check('health reports recent errors', typeof state.body?.health?.recentErrors === 'number', state.body?.health?.recentErrors)
} else {
  console.log('SKIP real store: no Mnemon data root found')
}


// ---- health instrument wiring: context pressure, schedules, recent errors ----
{
  const dir2 = mkdtempSync(join(tmpdir(), 'jarvis-health-'))
  mkdirSync(join(dir2, 'runtime'), { recursive: true })
  writeFileSync(join(dir2, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
    { content: 'health probe entry', target: 'memory', importance: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ] }))
  writeFileSync(join(dir2, 'runtime', 'MEMORY.md'), 'M'.repeat(1000))

  const routes2 = new Map()
  const listeners2 = new Map()
  const ctx2 = {
    on(name, fn) {
      if (!listeners2.has(name)) listeners2.set(name, [])
      listeners2.get(name).push(fn)
      return () => {}
    },
    effect(execute) { return execute() || (() => {}) },
    get(name) {
      if (name === 'config') return { resolveConfigByPackage: () => ({ dataDir: dir2 }) }
      if (name === 'systemPrompt') return { section: () => () => {} }
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'agents') return { list: () => [{ session: { id: 's1' } }, { session: { id: 's2' } }] }
      if (name === 'tokenMeter') {
        return { contextPressure: (session) => (session.id === 's2' ? { pressureTokens: 800000, contextWindow: 1000000 } : { pressureTokens: 1000, contextWindow: 1000000 }) }
      }
      if (name === 'schedule') {
        return { list: async () => ({ items: [{ scheduledAt: '2026-12-07T01:00:00.000Z' }, { scheduledAt: '2026-12-01T01:00:00.000Z' }], total: 2 }) }
      }
      return undefined
    },
    webServer: { register(route) { routes2.set(route.kind + ' ' + route.path, route); return () => routes2.delete(route.kind + ' ' + route.path) } },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  apply(ctx2, { nodeCount: 300, chronicle: false })
  const read = () => {
    const route = routes2.get('exact /dsh-jarvis/state')
    let payload = ''
    route.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(body) { payload += body } })
    return JSON.parse(payload)
  }
  const first = read()
  check('health: busiest session sets context ratio', first.health?.contextRatio === 0.8, first.health?.contextRatio)
  check('health: context tokens reported', first.health?.contextTokens === 800000 && first.health?.contextWindow === 1000000, [first.health?.contextTokens, first.health?.contextWindow])
  check('health: live session count', first.health?.sessions === 2, first.health?.sessions)
  await new Promise((resolve) => setTimeout(resolve, 60))
  const second = read()
  check('health: schedules read from the service', second.health?.schedulesActive === 2, second.health?.schedulesActive)
  check('health: next due task is the earliest', second.health?.nextDueAt === '2026-12-01T01:00:00.000Z', second.health?.nextDueAt)
  for (const fn of listeners2.get('agent/error') || []) fn({ agent: { id: 's1' } })
  const third = read()
  check('health: recent errors counted', third.health?.recentErrors === 1, third.health?.recentErrors)
  rmSync(dir2, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)



