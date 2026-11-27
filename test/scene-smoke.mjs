// Harness for scene detection: a recent instruction or tool names the work
// scene, the prompt carries it, and jarvis_context returns matching memories.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-scene-'))
const memoryDir = join(root, 'memory')
mkdirSync(join(memoryDir, 'runtime'), { recursive: true })
writeFileSync(join(memoryDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
  { content: 'Unity 项目的粒子着色器要按 URP 规范写', target: 'memory', importance: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { content: '企业微信的 wecom-cli 要用绝对路径调用', target: 'memory', importance: 'critical', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { content: '和场景无关的一条记忆', target: 'memory', importance: 'normal', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
] }))

function makeCtx() {
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
      if (name === 'config') return { resolveConfigByPackage: () => ({ dataDir: memoryDir }) }
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
  return { ctx, routes, registered, contexts, listeners }
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

function sessionWith(text) {
  return { id: 'session-scene', deriveMessages() { return [{ role: 'user', content: [{ type: 'text', text }] }] } }
}

// --- 1. an instruction names the scene, the prompt carries it, the tool finds memories ---
{
  const { ctx, routes, registered, contexts, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c1'), backupDir: join(root, 'b1'), alerts: false })
  const sceneContext = contexts.find((entry) => entry.name === 'jarvis:scene')
  check('the scene context is registered', !!sceneContext, contexts.map((c) => c.name))
  check('no scene before anything happens', sceneContext.text({}) === '' && state(routes).scene === null, [sceneContext.text({}), state(routes).scene])

  emit(listeners, 'session/event', sessionWith('帮我看看 Unity 的粒子着色器'), { type: 'step/start', data: { turn: 1, step: 1 } })
  const active = state(routes).scene
  check('an instruction sets the scene', active && active.id === 'unity', active)
  check('the prompt names the scene', /当前场景：Unity/u.test(sceneContext.text({})), sceneContext.text({}))

  const tool = registered.find((definition) => definition.name === 'jarvis_context')
  check('the context tool is registered', !!tool, registered.map((d) => d.name))
  const listed = await tool.execute({}, {})
  check('list reports the scene', listed.scene && listed.scene.id === 'unity', listed)
  const found = await tool.execute({ action: 'find' }, {})
  check('find returns matching memories', found.entries.length >= 1 && found.entries.some((entry) => entry.text.includes('URP')), found.entries)
  check('find does not return unrelated memories', !found.entries.some((entry) => entry.text.includes('和场景无关')), found.entries)
}

// --- 2. a tool name can set the scene too ---
{
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c2'), backupDir: join(root, 'b2'), alerts: false })
  emit(listeners, 'session/event', sessionWith('随便说一句'), { type: 'step/start', data: { turn: 1, step: 1 } })
  check('a neutral sentence leaves no scene', state(routes).scene === null, state(routes).scene)
// the plugin's own tools must not decide what work this is
  emit(listeners, 'session/event', sessionWith('随便说一句'), { type: 'tool/call', data: { callId: 'c2', name: 'jarvis_context' } })
  check('a self tool leaves no scene', state(routes).scene === null, state(routes).scene)
  emit(listeners, 'session/event', sessionWith('继续'), { type: 'tool/call', data: { callId: 'c1', name: 'wecom_send_message' } })
  check('a tool name sets the scene', (state(routes).scene || {}).id === 'wecom', state(routes).scene)
}

// --- 3. scene: false disables the whole feature ---
{
  const { ctx, registered, contexts, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c3'), backupDir: join(root, 'b3'), alerts: false, scene: false })
  check('scene off registers no context', !contexts.some((entry) => entry.name === 'jarvis:scene'), contexts.map((c) => c.name))
  check('scene off registers no tool', !registered.some((d) => d.name === 'jarvis_context'), registered.map((d) => d.name))
  emit(listeners, 'session/event', sessionWith('Unity 项目'), { type: 'step/start', data: { turn: 1, step: 1 } })
}

// --- 4. a scene goes stale after ten minutes ---
{
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const { ctx, routes, contexts, listeners } = makeCtx()
    apply(ctx, { nodeCount: 300, memoryDirs: [memoryDir], chronicleDir: join(root, 'c4'), backupDir: join(root, 'b4'), alerts: false })
    emit(listeners, 'session/event', sessionWith('Unity 的 URP 材质'), { type: 'step/start', data: { turn: 1, step: 1 } })
    const sceneContext = contexts.find((entry) => entry.name === 'jarvis:scene')
    check('the scene is live immediately', (state(routes).scene || {}).id === 'unity', state(routes).scene)
    clock += 11 * 60 * 1000
    check('a stale scene leaves the prompt', sceneContext.text({}) === '', sceneContext.text({}))
    check('a stale scene leaves the snapshot', state(routes).scene === null, state(routes).scene)
  } finally {
    Date.now = realNow
  }
}
rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
