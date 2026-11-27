// Harness for the read-only detail route behind the clickable sphere.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-panel-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
  { content: '面板测试条目一', target: 'memory', importance: 'critical', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
] }))
writeFileSync(join(memoryDir, 'runtime', 'MEMORY.md'), 'M'.repeat(200))
writeFileSync(join(memoryDir, 'runtime', 'USER.md'), 'U'.repeat(20))

function makeCtx() {
  const routes = new Map()
  const effects = []
  const ctx = {
    on() { return () => {} },
    effect(execute) {
      const dispose = execute() || (() => {})
      effects.push(dispose)
      return dispose
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
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  return { ctx, routes, effects }
}

function request(route, path, method = 'GET') {
  let payload = ''
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { if (body !== undefined) payload += body },
  }
  route.handler({ method, url: path }, res)
  return { status: res.statusCode, headers: res.headers, body: payload }
}

const { ctx, routes, effects } = makeCtx()
const dispose = apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'chr'), backupDir: join(root, 'bk'), alerts: false })

check('the detail route is registered', routes.has('/dsh-jarvis/detail'), [...routes.keys()])

const overview = request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail')
const parsed = JSON.parse(overview.body)
check('overview answers 200 with items', overview.status === 200 && Array.isArray(parsed.items) && parsed.items.length > 0, parsed)
check('overview has a title', typeof parsed.title === 'string' && parsed.title.length > 0, parsed.title)

for (const kind of ['memory', 'alerts', 'recap', 'backup', 'doctor', 'chronicle']) {
  const got = request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=' + kind)
  const data = JSON.parse(got.body)
  check('kind=' + kind + ' answers with items', got.status === 200 && Array.isArray(data.items) && data.items.length > 0, data)
}

const memory = JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=memory').body)
check('memory detail includes the entry text', memory.items.some((item) => String(item.value).includes('面板测试条目一')), memory.items)

const unknown = JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=nope').body)
check('an unknown kind falls back to overview', unknown.kind === 'nope' && unknown.title === '状态', unknown)

const post = request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail', 'POST')
check('POST is rejected with 405', post.status === 405, post.status)
const head = request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail', 'HEAD')
check('HEAD answers 200 without a body', head.status === 200 && head.body === '', [head.status, head.body.length])

// disposing the plugin releases the route (the host runs each effect disposer)
void dispose
for (const release of effects) release()
check('dispose releases the detail route', !routes.has('/dsh-jarvis/detail'), [...routes.keys()])

rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
