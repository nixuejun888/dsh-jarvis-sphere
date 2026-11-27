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
check('a POST without a stream is refused', post.status === 400, post.status)
const head = request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail', 'HEAD')
check('HEAD answers 200 without a body', head.status === 200 && head.body === '', [head.status, head.body.length])

// disposing the plugin releases the route (the host runs each effect disposer)
void dispose
for (const release of effects) release()
check('dispose releases the detail route', !routes.has('/dsh-jarvis/detail'), [...routes.keys()])

// --- 2. disabled subsystems and traversal are handled without leaking data ---
{
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c2'), backupDir: join(root, 'b2'), alerts: false, chronicle: false, recap: false })
  const chronicle = JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=chronicle').body)
  check('a disabled chronicle says so', chronicle.items.some((item) => String(item.value).includes('已关闭')), chronicle.items)
  const recap = JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=recap').body)
  check('a disabled recap says so', recap.items.some((item) => String(item.value).includes('已关闭')), recap.items)

  for (const probe of ['?kind=../../etc/passwd', '?kind=%2e%2e%2f%2e%2e%2fetc%2fpasswd', '?kind=' + 'x'.repeat(5000)]) {
    const got = request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail' + probe)
    check('traversal-ish kind stays a JSON answer (' + probe.slice(0, 24) + ')', got.status === 200 && got.body.includes('"ok":true'), got.status)
  }
  check('traversal never returns file content', !JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=../../etc/passwd').body).items.some((item) => /root:|bin:/u.test(String(item.value))), true)
}

// --- 3. a truncated list says how many are hidden ---
{
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c3'), backupDir: join(root, 'b3'), alerts: false })
  const doctor = JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=doctor').body)
  check('doctor detail stays within the item cap', doctor.items.length <= 15, doctor.items.length)
}
// --- 4. recap off hides the alert; long lists report the remainder ---
{
  const dir = join(root, 'c4')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'review-queue.json'), JSON.stringify({ pending: [{ t: new Date().toISOString(), s: 's', text: '旧规则' }], recent: [] }))
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: dir, backupDir: join(root, 'b4'), alerts: true, recap: false })
  const body = request(routes.get('/dsh-jarvis/state'), '/dsh-jarvis/state').body
  const snapshot = JSON.parse(body)
  check('recap off hides the queue alert', !(snapshot.alerts.active || []).some((alert) => alert.id === 'recap'), snapshot.alerts)
}

{
  const many = join(root, 'many')
  mkdirSync(join(many, 'runtime'), { recursive: true })
  const entries = []
  for (let i = 0; i < 20; i += 1) {
    entries.push({ content: '记忆条目 ' + i, target: 'memory', importance: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  }
  writeFileSync(join(many, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries }))
  writeFileSync(join(many, 'runtime', 'MEMORY.md'), 'M'.repeat(100))
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDir: many, memoryDirs: [many], chronicleDir: join(root, 'c5'), backupDir: join(root, 'b5'), alerts: false })
  const memory = JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=memory').body)
  const more = memory.items.find((item) => item.label === '更多')
  check('a long list reports how many are hidden', !!more && /另有 \d+ 项/u.test(more.value), memory.items.slice(-2))
}
// --- 7. the page can report its layout, and the panel shows it ---
{
  const { Readable } = await import('node:stream')
  const { ctx, routes } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c7'), backupDir: join(root, 'b7'), alerts: false })
  const route = routes.get('/dsh-jarvis/detail')
  const stream = Readable.from([JSON.stringify({ pick: 'tall sibling · div.main', mode: 'lifted', size: '1236x973', chain: 'textarea 900x80|div.main 1000x900' })])
  stream.method = 'POST'
  stream.url = '/dsh-jarvis/detail'
  let status = 0
  route.handler(stream, { statusCode: 0, setHeader() {}, end(body) { status = status || 204 } })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const layout = JSON.parse(request(routes.get('/dsh-jarvis/detail'), '/dsh-jarvis/detail?kind=layout').body)
  check('the layout report is stored and shown', layout.items.some((item) => String(item.value).includes('div.main')), layout.items)
}
rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
