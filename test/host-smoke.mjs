// Standalone harness: exercise the Host half with a fake Cordis context.
import { apply } from '../index.js'

const listeners = new Map()
const routes = new Map()

const ctx = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
    return () => {}
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  agents: { list: () => [] },
}

const dispose = apply(ctx, { nodeCount: 300, chronicle: false })

function emit(name, ...args) {
  for (const fn of listeners.get(name) || []) fn(...args)
}

function getState() {
  const route = routes.get('/dsh-jarvis/state')
  let payload = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(body) { if (body !== undefined) payload += body },
  }
  route.handler({ method: 'GET' }, res)
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(payload) }
}

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

// 1. idle
let snap = getState().body
check('idle running=false', snap.running === false, snap.running)
check('build marker', snap.build === 3, snap.build)
check('cfg passes nodeCount', snap.cfg.nodeCount === 300, snap.cfg.nodeCount)

// 2. stream frames make it busy
for (let i = 0; i < 20; i++) emit('agent/assistant-stream', { agent: { id: 's1' }, frame: {} })
snap = getState().body
check('stream -> running true', snap.running === true, snap.running)
check('streamRate > 0', snap.streamRate > 0, snap.streamRate)

// 3. tool call
emit('session/event', { id: 's1' }, { type: 'tool/call', data: { callId: 'c1', name: 'ops_bash' } })
snap = getState().body
check('tool counted', snap.counters.tools === 1, snap.counters.tools)
check('tool name captured', snap.lastTool === 'ops_bash', snap.lastTool)
check('active tool listed', snap.activeTools.includes('ops_bash'), snap.activeTools)
check('pulse > 0', snap.pulse > 0, snap.pulse)

// 4. tool result retires it
emit('session/event', { id: 's1' }, { type: 'tool/result', data: { callId: 'c1' } })
snap = getState().body
check('active tool retired', snap.activeTools.length === 0, snap.activeTools)
check('tool count retained', snap.counters.tools === 1, snap.counters.tools)

// 5. turn end counts a turn
emit('session/event', { id: 's1' }, { type: 'turn/end', data: {} })
snap = getState().body
check('turn counted on turn/end', snap.counters.turns === 1, snap.counters.turns)

// 6. assistant message + user message
emit('session/event', { id: 's1' }, { type: 'assistant/message', data: { usage: {} } })
emit('session/event', { id: 's1' }, { type: 'user/message', data: {} })
snap = getState().body
check('messages counted', snap.counters.messages === 1, snap.counters.messages)
check('user messages counted', snap.counters.userMessages === 1, snap.counters.userMessages)

// 7. agent/status map
emit('agent/status', { agent: { id: 's9' }, status: 'running' })
snap = getState().body
check('agent/status -> running', snap.running === true, snap.running)
check('agents count', snap.agents === 1, snap.agents)
emit('agent/disposed', { agent: { id: 's9' } })
snap = getState().body
check('disposed clears status', snap.agents === 0, snap.agents)

// 8. subagent + error counters
emit('subagent/start', { id: 'sub-1' })
emit('agent/error', { agent: { id: 's1' }, turn: 1, step: 1, error: new Error('x') })
snap = getState().body
check('subagent counted', snap.counters.subagents === 1, snap.counters.subagents)
check('errors counted', snap.counters.errors === 1, snap.counters.errors)

// 9. HEAD and method guard
const route = routes.get('/dsh-jarvis/state')
let postCode = 0
route.handler({ method: 'POST' }, { statusCode: 0, setHeader() {}, end() { postCode = this.statusCode } })
check('POST -> 405', postCode === 405, postCode)

// 10. dispose removes the route
dispose()
check('dispose removes route', routes.size === 0, routes.size)

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
