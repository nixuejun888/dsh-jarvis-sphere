// Regression harness for the route lifecycle.
//
// The loader ignores a disposer returned from `apply`, so the route must be
// owned through `ctx.effect`. An older build that leaked ROUTE_PATH keeps
// answering from one process-wide table, so a re-enabled instance must claim
// the alternate route instead of failing with "duplicate exact route".
import { apply } from '../index.js'

const PRIMARY = 'exact /dsh-jarvis/state'
const ALTERNATE = 'exact /dsh-jarvis/state-v2'

/** Fake Cordis context with real route-map semantics and effect collection. */
function makeCtx(routes = new Map()) {
  const listeners = new Map()
  const effects = []
  return {
    routes,
    effects,
    logger: { warn(message) { console.log('LOG', message) } },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {
        const list = listeners.get(name) || []
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
      }
    },
    effect(execute, label) {
      void label
      const dispose = execute()
      effects.push(dispose)
      return dispose
    },
    webServer: {
      // Matches the Host: a duplicate (kind, path) throws.
      register(route) {
        const key = route.kind + ' ' + route.path
        if (routes.has(key)) throw new Error('webserver: duplicate ' + route.kind + ' route "' + route.path + '"')
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
    agents: { list: () => [] },
  }
}

function getState(ctx, key) {
  const route = ctx.routes.get(key)
  if (!route) return { missing: true }
  let payload = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    end(body) { if (body !== undefined) payload += body },
  }
  route.handler({ method: 'GET' }, res)
  return { status: res.statusCode, body: payload ? JSON.parse(payload) : null }
}

/** Dispose every effect of one instance, the way a fiber unload does. */
function unload(ctx) {
  for (const dispose of ctx.effects.splice(0)) {
    if (typeof dispose === 'function') dispose()
  }
}

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

// 1. First instance registers the primary route and serves its own config.
const a = makeCtx()
apply(a, { nodeCount: 111, chronicle: false })
let state = getState(a, PRIMARY)
check('A registers the primary route', state.status === 200, state.status)
check('A serves its config', state.body?.cfg?.nodeCount === 111, state.body?.cfg?.nodeCount)
check('A advertises build 3', state.body?.build === 4, state.body?.build)

// 2. Disabling must release the route: a re-enable has to register again
//    instead of hitting "duplicate exact route".
unload(a)
check('disable removes the route', a.routes.size === 0, a.routes.size)
apply(a, { nodeCount: 112, chronicle: false })
state = getState(a, PRIMARY)
check('re-enable re-registers', state.status === 200, state.status)
check('re-enable serves fresh config', state.body?.cfg?.nodeCount === 112, state.body?.cfg?.nodeCount)

// 3. An older build leaks PRIMARY (its disposer was never wired). A new
//    instance must activate on the alternate route and leave the frozen
//    handler alone, so the Client half can skip it by build.
const frozenRoutes = new Map()
frozenRoutes.set(PRIMARY, {
  kind: 'exact',
  path: '/dsh-jarvis/state',
  handler(_req, res) {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ build: 2, cfg: { nodeCount: 1 } }))
  },
})
const b = makeCtx(frozenRoutes)
let threw = null
try {
  apply(b, { nodeCount: 222, chronicle: false })
} catch (error) {
  threw = error
}
check('B activates over a leaked primary route', threw === null, threw === null ? null : String(threw?.message))
state = getState(b, ALTERNATE)
check('B claims the alternate route', state.status === 200, state.status)
check('alternate serves B data', state.body?.cfg?.nodeCount === 222, state.body?.cfg?.nodeCount)
check('alternate advertises build 3', state.body?.build === 4, state.body?.build)
check('frozen primary is untouched', getState(b, PRIMARY).body?.build === 2, getState(b, PRIMARY).body?.build)

// 4. Unloading B releases the alternate route but cannot touch the frozen one.
unload(b)
check('unload releases the alternate route', b.routes.has(ALTERNATE) === false, [...b.routes.keys()])
check('frozen primary still answers', b.routes.has(PRIMARY) === true, [...b.routes.keys()])

// 5. Method guard still holds on a live route.
const route = b.routes.get(PRIMARY)
let postCode = 0
route.handler({ method: 'POST' }, { statusCode: 0, setHeader() {}, end() { postCode = this.statusCode } })
check('frozen handler keeps its own guard', postCode === 200, postCode)
let alternatePost = 0
apply(b, { nodeCount: 333, chronicle: false })
b.routes.get(ALTERNATE).handler({ method: 'POST' }, { statusCode: 0, setHeader() {}, end() { alternatePost = this.statusCode } })
check('POST -> 405', alternatePost === 405, alternatePost)

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
