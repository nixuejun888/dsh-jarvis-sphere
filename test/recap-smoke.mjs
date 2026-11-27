// Harness for the auto-recap queue: durable-sounding instructions are queued,
// surfaced as an alert, and only removed after a human confirms or drops them.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-recap-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [] }))

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
  return {
    deriveMessages() {
      return [{ role: 'user', content: [{ type: 'text', text }] }]
    },
  }
}

// --- 1. a durable-sounding instruction is queued and surfaced ---
{
  const chronicleDir = join(root, 'chronicle-1')
  const { ctx, routes, listeners, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'b1'), alerts: true })
  const session = sessionWith('以后备份都放到 D 盘')
  emit(listeners, session, { type: 'step/start', data: { turn: 1, step: 1 } })
  emit(listeners, session, { type: 'turn/end', data: { turn: 1 } })

  const queueFile = join(chronicleDir, 'review-queue.json')
  check('the instruction lands in the review queue', existsSync(queueFile), existsSync(queueFile))
  const queue = JSON.parse(readFileSync(queueFile, 'utf8'))
  check('the queue keeps the instruction text', queue.pending.length === 1 && queue.pending[0].text.includes('以后备份'), queue.pending)
  const alerts = state(routes).alerts
  check('the queue raises an alert', (alerts.active || []).some((alert) => alert.id === 'recap'), alerts)

  const tool = registered.find((definition) => definition.name === 'jarvis_recap')
  check('the recap tool is registered', !!tool, registered.map((d) => d.name))
  const listed = await tool.execute({}, {})
  check('the tool lists the queue', listed.count === 1 && listed.pending.length === 1, listed)

  // the same instruction is not queued twice
  emit(listeners, session, { type: 'step/start', data: { turn: 2, step: 1 } })
  emit(listeners, session, { type: 'turn/end', data: { turn: 2 } })
  check('the same text is queued once', JSON.parse(readFileSync(queueFile, 'utf8')).pending.length === 1, JSON.parse(readFileSync(queueFile, 'utf8')).pending.length)

  // an ordinary sentence is not queued
  emit(listeners, sessionWith('今天天气不错我们去散步'), { type: 'step/start', data: { turn: 3, step: 1 } })
  emit(listeners, sessionWith('今天天气不错我们去散步'), { type: 'turn/end', data: { turn: 3 } })
  check('ordinary text is not queued', JSON.parse(readFileSync(queueFile, 'utf8')).pending.length === 1, JSON.parse(readFileSync(queueFile, 'utf8')).pending.length)

  const confirmed = await tool.execute({ action: 'confirm' }, {})
  check('confirming removes the item', confirmed.remaining === 0 && confirmed.resolved.length === 1, confirmed)
  check('the alert clears with the queue', !(state(routes).alerts.active || []).some((alert) => alert.id === 'recap'), state(routes).alerts)
}

// --- 2. recap: false disables both the queue and the tool ---
{
  const chronicleDir = join(root, 'chronicle-2')
  const { ctx, routes, listeners, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir, backupDir: join(root, 'b2'), alerts: true, recap: false })
  emit(listeners, sessionWith('以后都不要用 codex 复查'), { type: 'step/start', data: { turn: 1, step: 1 } })
  emit(listeners, sessionWith('以后都不要用 codex 复查'), { type: 'turn/end', data: { turn: 1 } })
  check('recap off queues nothing', !existsSync(join(chronicleDir, 'review-queue.json')), existsSync(join(chronicleDir, 'review-queue.json')))
  check('recap off registers no tool', !registered.some((d) => d.name === 'jarvis_recap'), registered.map((d) => d.name))
  check('recap off raises no alert', !(state(routes).alerts.active || []).some((alert) => alert.id === 'recap'), state(routes).alerts)
}

rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
