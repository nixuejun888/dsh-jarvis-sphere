// Harness for the event pulses: tool calls and errors leave a bounded, recent
// trail in the snapshot; nothing else is recorded.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-pulse-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))

function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
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
      if (name === 'tools') return { register: () => () => {} }
      if (name === 'agents') return { list: () => [] }
      if (name === 'tokenMeter') return { contextPressure: () => ({}) }
      if (name === 'schedule') return { list: async () => ({ items: [], total: 0 }) }
      if (name === 'webServer') return {}
      return undefined
    },
    webServer: { register(route) { routes.set(route.kind + ' ' + route.path, route); return () => {} } },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  return { ctx, routes, listeners }
}

function emit(listeners, name, ...args) {
  for (const fn of listeners.get(name) || []) fn(...args)
}

function state(routes) {
  const route = routes.get('exact /dsh-jarvis/state')
  let payload = ''
  route.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(body) { payload += body } })
  return JSON.parse(payload)
}

const session = { id: 'session-pulse', deriveMessages: () => [] }

// --- 1. a tool call and an error become pulses, a turn end does not ---
{
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c1'), backupDir: join(root, 'b1'), alerts: false })
  check('the snapshot carries a pulse list', Array.isArray(state(routes).pulses), state(routes).pulses)
  emit(listeners, 'session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'read' } })
  emit(listeners, 'session/event', session, { type: 'tool/result', data: { callId: 'c1' } })
  emit(listeners, 'agent/error', { agent: { id: 's1' }, turn: 1, step: 1, error: new Error('x') })
  emit(listeners, 'session/event', session, { type: 'turn/end', data: { turn: 1 } })
  const pulses = state(routes).pulses
  check('a tool call is recorded', pulses.some((pulse) => pulse.k === 'tool'), pulses)
  check('an error is recorded', pulses.some((pulse) => pulse.k === 'error'), pulses)
  check('a turn end is not a pulse', pulses.length === 2, pulses.length)
  check('every pulse has a monotonic seq and a time', pulses.every((pulse, index) => index === 0 || pulse.s > pulses[index - 1].s) && pulses.every((pulse) => Number.isFinite(pulse.t)), pulses)
}

// --- 2. the ring is bounded and the payload stays small ---
{
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c2'), backupDir: join(root, 'b2'), alerts: false })
  for (let i = 0; i < 40; i += 1) emit(listeners, 'session/event', session, { type: 'tool/call', data: { callId: 'c' + i, name: 'read' } })
  const pulses = state(routes).pulses
  check('the pulse ring is bounded', pulses.length <= 12, pulses.length)
  check('the pulse payload is small', JSON.stringify(pulses).length < 700, JSON.stringify(pulses).length)
}

// --- 3. pulse: false silences the trail ---
{
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c3'), backupDir: join(root, 'b3'), alerts: false, pulse: false })
  emit(listeners, 'session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'read' } })
  emit(listeners, 'agent/error', { agent: { id: 's1' }, turn: 1, step: 1, error: new Error('x') })
  check('pulse off sends nothing', state(routes).pulses.length === 0, state(routes).pulses)
}

rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
