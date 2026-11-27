// Harness for the read-only memory audit: exact/near duplicates, stale and
// oversized entries, capacity pressure, and tool registration shape.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditStore, renderReport, registerKeeper } from '../keeper.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const dir = mkdtempSync(join(tmpdir(), 'jarvis-keeper-'))
mkdirSync(join(dir, 'runtime'), { recursive: true })
mkdirSync(join(dir, 'documents'), { recursive: true })
mkdirSync(join(dir, 'data'), { recursive: true })

const now = Date.parse('2026-11-27T10:00:00Z')
const daysAgo = (days) => new Date(now - days * 86400000).toISOString()

const entries = [
  { content: '用户偏好：一键化方案。', target: 'user', importance: 'critical', created_at: daysAgo(4), updated_at: daysAgo(4) },
  // exact duplicate of entry 0 (whitespace/case/punctuation differ)
  { content: '用户偏好：一键化方案', target: 'user', importance: 'normal', created_at: daysAgo(4), updated_at: daysAgo(4) },
  // near duplicate of entry 0
  { content: '用户偏好：要一键化方案，不要碎片。', target: 'user', importance: 'normal', created_at: daysAgo(3), updated_at: daysAgo(3) },
  { content: '插件注册必须放进 ctx.effect，因为加载器忽略 apply 返回值。', target: 'memory', importance: 'critical', created_at: daysAgo(2), updated_at: daysAgo(2) },
  { content: '很久以前的一条普通结论，早该归档了。', target: 'memory', importance: 'normal', created_at: daysAgo(200), updated_at: daysAgo(200) },
  { content: 'X'.repeat(1000), target: 'memory', importance: 'normal', created_at: daysAgo(1), updated_at: daysAgo(1) },
]
writeFileSync(join(dir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries }))
writeFileSync(join(dir, 'runtime', 'MEMORY.md'), 'M'.repeat(9000))
writeFileSync(join(dir, 'runtime', 'USER.md'), 'U'.repeat(500))
writeFileSync(join(dir, 'documents', 'index.json'), JSON.stringify({ version: 1, documents: new Array(58).fill(0).map((_, i) => ({ id: 'd' + String(i) })) }))
writeFileSync(join(dir, 'data', '.dsh-memory-bodies.json'), JSON.stringify({ version: 1, bodies: [{ id: 'a', active: true }, { id: 'b', active: false }] }))

const report = auditStore(dir, { now, limits: { memoryLimitBytes: 10240, userLimitBytes: 4096 } })

check('report ok', report.ok === true, report.ok)
check('counts entries', report.counts.entries === 6, report.counts.entries)
check('counts user vs memory', report.counts.user === 3 && report.counts.memory === 3, [report.counts.user, report.counts.memory])
check('counts spaces and documents', report.counts.spaces === 2 && report.counts.documents === 58, [report.counts.spaces, report.counts.documents])
check('exact duplicate found', report.duplicates.length === 1 && report.duplicates[0].a === 0 && report.duplicates[0].b === 1, report.duplicates)
check('near duplicate found', report.near.length >= 1 && report.near[0].score >= 0.62, report.near.map((n) => [n.a, n.b, n.score]))
check('stale entry found', report.stale.length === 1 && report.stale[0].index === 4, report.stale.map((s) => s.index))
check('oversized entry found', report.oversized.length === 1 && report.oversized[0].index === 5, report.oversized.map((s) => s.index))
check('capacity pressure flagged', report.capacity.memoryRatio > 0.85 && report.suggestions.some((s) => s.includes('已用') && s.includes('88%')), [report.capacity.memoryRatio, report.suggestions[0]])
check('user limit comes from options', report.capacity.userLimitBytes === 4096 && report.capacity.userRatio > 0.1, [report.capacity.userLimitBytes, report.capacity.userRatio])
check('read-only disclaimer present', report.suggestions.some((s) => s.includes('只读')), report.suggestions)

const text = renderReport(report)
check('rendered report names the sections', /容量/.test(text) && /库存/.test(text) && /建议/.test(text), text.slice(0, 40))
check('rendered report stays bounded', text.length < 6000, text.length)

// Missing store reports a reason instead of throwing.
const empty = auditStore(join(dir, 'nope'))
check('missing store reports a reason', empty.ok === false && typeof empty.reason === 'string', empty.reason)

// Tool registration shape: name, empty schema, output renderer, execute.
const registered = []
const ctx = {
  get(name) {
    if (name !== 'tools') return undefined
    return { register(definition) { registered.push(definition); return () => { registered.length = 0 } } }
  },
  logger: { warn(message) { console.log('LOG', message) } },
}
const disposeTool = registerKeeper(ctx, () => dir)
check('tool registered', registered.length === 1, registered.length)
const definition = registered[0] || {}
check('tool name', definition.name === 'jarvis_memory_review', definition.name)
check('tool parameters are an empty object schema', definition.parameters?.type === 'object' && definition.parameters?.additionalProperties === false, definition.parameters)
check('tool output renders text', typeof definition.output?.render === 'function' && definition.output.render({}, report)[0].type === 'text', typeof definition.output?.render)
check('tool execute returns the report', typeof definition.execute === 'function')
const viaTool = await definition.execute({}, {})
check('tool execute audits the root', viaTool?.ok === true && viaTool.counts.entries === 6, viaTool?.counts?.entries)
disposeTool()
check('tool dispose unregisters', registered.length === 0, registered.length)

// No tools service: a no-op disposer, never a throw.
check('missing tools service reports no registration', registerKeeper({ get: () => undefined }, () => dir) === null, registerKeeper({ get: () => undefined }, () => dir))

// Secret scrubbing: previews are quoted into the model transcript, so they must
// never carry a key or a password.
const secretDir = mkdtempSync(join(tmpdir(), 'jarvis-secret-'))
mkdirSync(join(secretDir, 'runtime'), { recursive: true })
writeFileSync(join(secretDir, 'runtime', 'memories.json'), JSON.stringify({ version: 1, entries: [
  { content: 'API key sk-abcdefghijklmnopqrstuvwx 记住它', target: 'memory', importance: 'normal', created_at: daysAgo(1), updated_at: daysAgo(1) },
  { content: 'password: hunter2 是测试用', target: 'memory', importance: 'normal', created_at: daysAgo(1), updated_at: daysAgo(1) },
  { content: 'password hunter2 是测试用', target: 'memory', importance: 'normal', created_at: daysAgo(1), updated_at: daysAgo(1) },
] }))
const secretText = JSON.stringify(auditStore(secretDir, { now }))
check('secrets are scrubbed from previews', !secretText.includes('sk-abcdefghijklmnopqrstuvwx') && !secretText.includes('hunter2'), secretText.length)
check('scrub marker is visible', secretText.includes('[redacted]'), secretText.slice(0, 60))
rmSync(secretDir, { recursive: true, force: true })

// The limits resolver reaches the audit instead of the built-in defaults.
const disposeLimits = registerKeeper(ctx, () => dir, () => ({ memoryLimitBytes: 2048, userLimitBytes: 1024 }))
const withLimits = await (registered[0] || {}).execute?.({}, {})
check('limits resolver reaches the audit', withLimits?.capacity?.memoryLimitBytes === 2048 && withLimits?.capacity?.userLimitBytes === 1024, withLimits?.capacity)
disposeLimits()
rmSync(dir, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)



