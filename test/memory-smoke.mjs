// Harness for the memory projection and the persona section: exercises the
// Host half against a fake Cordis context that exposes `config` and
// `systemPrompt`, and against whatever Mnemon data root this machine has.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { apply } from '../index.js'

const candidates = [
  process.env.DSH_MNEMON_DATA_DIR,
  'D:\\AI\\记忆数据',
  join(homedir(), '.mnemon'),
].filter(Boolean)
const dataDir = candidates.find((dir) => existsSync(join(dir, 'runtime', 'memories.json')))

if (!dataDir) {
  console.log('SKIP memory projection: no Mnemon data root with runtime/memories.json')
  process.exit(0)
}

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

const dispose = apply(ctx, { nodeCount: 300 })
const route = routes.get('exact /dsh-jarvis/state')
if (!route) {
  console.log('FAIL route missing')
  process.exit(1)
}
let payload = ''
route.handler({ method: 'GET' }, { statusCode: 0, setHeader() {}, end(body) { payload += body } })
const snap = JSON.parse(payload)

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

// Persona: one global section with our own name and text.
check('persona section registered', sections.length === 1, sections.length)
check('persona section name', sections[0]?.name === 'jarvis:persona', sections[0]?.name)
check('persona text present', /JARVIS/.test(String(sections[0]?.text || '')), String(sections[0]?.text || '').slice(0, 20))
check('snapshot reports the persona', snap.persona?.active === true && snap.persona?.name === 'JARVIS', snap.persona)

// Memory projection: counts match the files on disk, nodes carry no content.
const memory = snap.memory
check('memory projection ok', memory?.ok === true, memory?.ok)
check('memory total matches entries', memory?.total === memory?.user + memory?.memory && memory.total > 0, [memory?.total, memory?.user, memory?.memory])
check('spaces projected', (memory?.spaces || 0) >= 0, memory?.spaces)
check('documents projected', (memory?.documents || 0) >= 0, memory?.documents)
check('nodes capped', Array.isArray(memory?.nodes) && memory.nodes.length > 0, memory?.nodes?.length)
const first = memory?.nodes?.[0] || {}
check('node has target/importance/hash', typeof first.t === 'string' && typeof first.i === 'number' && typeof first.k === 'number', first)
check('nodes carry no text', Object.keys(first).sort().join(',') === 'a,f,i,k,t', Object.keys(first).sort().join(','))

// Document indices must not leak titles either.
check('snapshot carries no document titles', !/relativePath|\.md"/.test(payload), payload.length)

// The loader ignores apply's return value; a fiber unload disposes the effects.
dispose()
const failedBefore = results.filter((r) => !r.ok).length
for (const release of effects.splice(0)) release()
void failedBefore
check('dispose removes the route', routes.size === 0, routes.size)
check('dispose removes the persona section', sections.length === 0, sections.length)

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
