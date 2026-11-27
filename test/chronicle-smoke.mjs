// Harness for the daily chronicle: one JSON line per finished turn, a bounded
// file, a reload-safe daily count, and the read-only tool on top of it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

const root = mkdtempSync(join(tmpdir(), 'jarvis-chronicle-'))
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
      if (name === 'systemPrompt') return { section: () => () => {} }
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
      return undefined
    },
    webServer: {
      register(route) {
        routes.set(route.kind + ' ' + route.path, route)
        return () => routes.delete(route.kind + ' ' + route.path)
      },
    },
    agents: { list: () => [] },
    logger: { warn() {} },
  }
  return { ctx, routes, listeners, registered }
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

const dir = join(root, 'chronicle')
const userMessage = (text) => ({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })

// --- 1. a finished turn appends exactly one line with a clipped label ---
{
  const { ctx, routes, listeners, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: dir })
  const longLabel = '把' + '这个'.repeat(80) + '\n第二行'
  emit(listeners, 'session/event', { id: 'session-abcdefghijkl' }, userMessage(longLabel))
  emit(listeners, 'session/event', { id: 'session-abcdefghijkl' }, { type: 'tool/call', data: { callId: 'c1', name: 'ops_bash' } })
  emit(listeners, 'session/event', { id: 'session-abcdefghijkl' }, { type: 'tool/call', data: { callId: 'c2', name: 'read' } })
  emit(listeners, 'session/event', { id: 'session-abcdefghijkl' }, { type: 'turn/end', data: { turn: 1 } })

  const file = join(dir, 'chronicle.jsonl')
  check('chronicle file is created on turn end', existsSync(file), existsSync(file))
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  check('exactly one line per turn', lines.length === 1, lines.length)
  const record = JSON.parse(lines[0])
  check('label is clipped and flattened', record.u.length <= 80 && !record.u.includes('\n'), [record.u.length, record.u.includes('\n')])
  check('tools are counted per turn', record.tools === 2, record.tools)
  check('session id is short', String(record.s).length <= 12, record.s)
  check('day key is a local date', /^\d{4}-\d{2}-\d{2}$/u.test(record.d), record.d)
  check('snapshot reports today', state(routes).chronicle?.todayTurns === 1, state(routes).chronicle?.todayTurns)

  const tool = registered.find((definition) => definition.name === 'jarvis_chronicle')
  check('chronicle tool is registered', !!tool, registered.map((d) => d.name))
  const value = await tool.execute({ limit: 5 }, {})
  check('tool reports the summary', value.summary?.todayTurns === 1 && value.summary?.days?.length === 1, value.summary)
  check('tool lists the recent turn', value.recent?.length === 1 && value.recent[0].tools === 2, value.recent?.length)
  const rendered = tool.output.render({}, value)[0]
  check('tool renders text', rendered?.type === 'text' && rendered.text.includes('编年史'), rendered?.text?.slice(0, 20))
}

// --- 2. a second apply reloads the tail, so today's count survives a restart ---
{
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: dir })
  check('restart recovers the daily count', state(routes).chronicle?.todayTurns === 1, state(routes).chronicle?.todayTurns)
  emit(listeners, 'session/event', { id: 's2' }, userMessage('继续'))
  emit(listeners, 'session/event', { id: 's2' }, { type: 'turn/end', data: { turn: 2 } })
  check('the count advances after reload', state(routes).chronicle?.todayTurns === 2, state(routes).chronicle?.todayTurns)
}

// --- 3. the file rotates instead of growing without bound ---
{
  const bigDir = join(root, 'big')
  mkdirSync(bigDir, { recursive: true })
  const bigFile = join(bigDir, 'chronicle.jsonl')
  const rows = []
  for (let i = 0; i < 3000; i += 1) rows.push(JSON.stringify({ t: new Date().toISOString(), d: '2026-01-01', s: 's', u: 'x'.repeat(180), tools: 1 }))
  writeFileSync(bigFile, rows.join('\n') + '\n')
  const before = readFileSync(bigFile, 'utf8').length
  const { ctx, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: bigDir })
  emit(listeners, 'session/event', { id: 's3' }, userMessage('触发轮换'))
  emit(listeners, 'session/event', { id: 's3' }, { type: 'turn/end', data: { turn: 3 } })
  const after = readFileSync(bigFile, 'utf8').split('\n').filter(Boolean).length
  check('chronicle rotates instead of growing', before > 400 * 1024 && after <= 2001, [before, after])
  check('rotation leaves no temp file', !existsSync(bigFile + '.tmp'), existsSync(bigFile + '.tmp'))
}

// --- 4. chronicle: false writes nothing ---
{
  const offDir = join(root, 'off')
  const { ctx, listeners, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: offDir, chronicle: false })
  emit(listeners, 'session/event', { id: 's4' }, userMessage('不该记录'))
  emit(listeners, 'session/event', { id: 's4' }, { type: 'turn/end', data: { turn: 4 } })
  check('chronicle can be turned off', !existsSync(join(offDir, 'chronicle.jsonl')), existsSync(join(offDir, 'chronicle.jsonl')))
  check('chronicle tool is not registered when off', !registered.some((d) => d.name === 'jarvis_chronicle'), registered.map((d) => d.name))
}

// --- 5. two sessions in flight never share a label or a tool baseline ---
{
  const twoDir = join(root, 'two')
  const { ctx, routes, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: twoDir })
  emit(listeners, 'session/event', { id: 'sessionAAAAAAA' }, userMessage('A 的任务'))
  emit(listeners, 'session/event', { id: 'sessionBBBBBBB' }, userMessage('B 的任务'))
  emit(listeners, 'session/event', { id: 'sessionAAAAAAA' }, { type: 'tool/call', data: { callId: 'a1', name: 'read' } })
  emit(listeners, 'session/event', { id: 'sessionBBBBBBB' }, { type: 'tool/call', data: { callId: 'b1', name: 'read' } })
  emit(listeners, 'session/event', { id: 'sessionBBBBBBB' }, { type: 'turn/end', data: { turn: 1 } })
  emit(listeners, 'session/event', { id: 'sessionAAAAAAA' }, { type: 'turn/end', data: { turn: 1 } })
  const rows = readFileSync(join(twoDir, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const b = rows.find((r) => r.s === 'sessionBBBBB')
  const a = rows.find((r) => r.s === 'sessionAAAAA')
  check('each session keeps its own label', b?.u === 'B 的任务' && a?.u === 'A 的任务', [a?.u, b?.u])
  check('each session counts only its own tools', a?.tools === 1 && b?.tools === 1, [a?.tools, b?.tools])
  check('today tools match the real calls', state(routes).chronicle?.todayTools === 2, state(routes).chronicle?.todayTools)
  check('today counts every recorded turn', state(routes).chronicle?.todayTurns === 2, state(routes).chronicle?.todayTurns)

  // a delegated child's session carries origin=subagent in its header
  const childDir = join(root, 'child')
  const child = makeCtx()
  apply(child.ctx, { nodeCount: 300, chronicleDir: childDir })
  const childSession = { id: 'session-child1', header: { id: 'session-child1', origin: 'subagent' } }
  emit(child.listeners, 'session/event', childSession, userMessage('子代理任务'))
  emit(child.listeners, 'session/event', childSession, { type: 'tool/call', data: { callId: 'c1', name: 'read' } })
  emit(child.listeners, 'session/event', childSession, { type: 'turn/end', data: { turn: 1 } })
  emit(child.listeners, 'session/event', { id: 'session-root1', header: { id: 'session-root1' } }, userMessage('根任务'))
  emit(child.listeners, 'session/event', { id: 'session-root1', header: { id: 'session-root1' } }, { type: 'turn/end', data: { turn: 1 } })
  const childRows = readFileSync(join(childDir, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  check('subagent turns are not chronicled', childRows.length === 1 && childRows[0].s === 'session-root', childRows.map((r) => r.s))
  check('root turn after a child keeps its own label', childRows[0]?.u === '根任务', childRows[0]?.u)
}

// --- 6. control characters are stripped from labels and rendered text ---
{
  const dirtyDir = join(root, 'dirty')
  const { ctx, listeners, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: dirtyDir })
  emit(listeners, 'session/event', { id: 's6' }, userMessage('正常\u0001控制\u001b[31m红尾'))
  emit(listeners, 'session/event', { id: 's6' }, { type: 'turn/end', data: { turn: 1 } })
  const row = JSON.parse(readFileSync(join(dirtyDir, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[0])
  check('control characters are stripped', !/[\u0000-\u001f\u007f-\u009f]/u.test(row.u), row.u)
  const tool = registered.find((definition) => definition.name === 'jarvis_chronicle')
  const rendered = tool.output.render({}, await tool.execute({}, {}))[0].text
  check('rendered text carries no control characters', !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(rendered), rendered.length)
}

// --- 7. rotation is byte bounded and leaves nothing behind ---
{
  const byteDir = join(root, 'bytes')
  mkdirSync(byteDir, { recursive: true })
  const byteFile = join(byteDir, 'chronicle.jsonl')
  const rows = []
  for (let i = 0; i < 4000; i += 1) rows.push(JSON.stringify({ t: new Date().toISOString(), d: '2026-01-02', s: 's', u: '标'.repeat(80), tools: 1 }))
  writeFileSync(byteFile, rows.join('\n') + '\n')
  const { ctx, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: byteDir })
  emit(listeners, 'session/event', { id: 's7' }, userMessage('轮换'))
  emit(listeners, 'session/event', { id: 's7' }, { type: 'turn/end', data: { turn: 1 } })
  const sizeAfter = readFileSync(byteFile, 'utf8').length
  check('rotation respects the byte budget', sizeAfter <= Math.floor(512 * 1024 * 0.8) + 400, sizeAfter)
  const leftovers = new Set()
  for (const name of (await import('node:fs')).readdirSync(byteDir)) if (name.endsWith('.tmp')) leftovers.add(name)
  check('rotation leaves no temp file', leftovers.size === 0, [...leftovers])
}
// --- 8. injected reminder blocks never become the chronicle label ---
{
  const injDir = join(root, 'injected')
  const { ctx, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: injDir })
  const message = {
    type: 'user/message',
    data: {
      role: 'user',
      content: [
        { type: 'text', text: '把球体的记忆改成光点' },
        { type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-27T11:17:25+08:00' },
      ],
    },
  }
  emit(listeners, 'session/event', { id: 's8' }, message)
  emit(listeners, 'session/event', { id: 's8' }, { type: 'turn/end', data: { turn: 1 } })
  const row = JSON.parse(readFileSync(join(injDir, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[0])
  check('injected reminder is not used as the label', row.u === '把球体的记忆改成光点', row.u)

  const sysDir = join(root, 'sysonly')
  const only = makeCtx()
  apply(only.ctx, { nodeCount: 300, chronicleDir: sysDir })
  emit(only.listeners, 'session/event', { id: 's9' }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '<system-reminder>only scaffolding</system-reminder>' }] } })
  emit(only.listeners, 'session/event', { id: 's9' }, { type: 'turn/end', data: { turn: 1 } })
  const onlyRow = JSON.parse(readFileSync(join(sysDir, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[0])
  check('a message with only scaffolding has an empty label', onlyRow.u === '', onlyRow.u)
}
// --- 9. a lost newline does not silently drop the glued record ---
{
  const gluedDir = join(root, 'glued')
  mkdirSync(gluedDir, { recursive: true })
  const gluedFile = join(gluedDir, 'chronicle.jsonl')
  const a = JSON.stringify({ t: '2026-01-15T03:00:00.000Z', d: '2026-01-15', s: 'sa', u: '第一条', tools: 1 })
  const b = JSON.stringify({ t: '2026-01-15T04:00:00.000Z', d: '2026-01-15', s: 'sb', u: '第二条', tools: 2 })
  writeFileSync(gluedFile, a + '\n' + b + a + '\n')
  const { ctx, routes, registered } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: gluedDir })
  const summary = state(routes).chronicle
  check('a glued record is recovered, not dropped', summary?.trackedDays === 1, summary?.trackedDays)
  const tool = registered.find((definition) => definition.name === 'jarvis_chronicle')
  const value = await tool.execute({ limit: 10 }, {})
  check('every recovered record is listed', value.recent.length === 3, value.recent.length)
  check('recovered records keep their labels', value.recent.map((r) => r.u).join('|') === '第一条|第二条|第一条', value.recent.map((r) => r.u))
}
// --- 10. an injected user message must not blank a captured label ---
{
  const order = join(root, 'label-order')
  const { ctx, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: order })
  const human = { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把球体的记忆改成光点' }] } }
  const injected = { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1' }] } }
  const onlyInjected = { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '<system-reminder>none</system-reminder>' }] } }

  emit(listeners, 'session/event', { id: 's10' }, human)
  emit(listeners, 'session/event', { id: 's10' }, injected)
  emit(listeners, 'session/event', { id: 's10' }, { type: 'turn/end', data: { turn: 1 } })
  const first = JSON.parse(readFileSync(join(order, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[0])
  check('a later injected message does not blank the label', first.u === '把球体的记忆改成光点', first.u)

  // the opposite order works too
  emit(listeners, 'session/event', { id: 's11' }, injected)
  emit(listeners, 'session/event', { id: 's11' }, human)
  emit(listeners, 'session/event', { id: 's11' }, { type: 'turn/end', data: { turn: 2 } })
  const second = JSON.parse(readFileSync(join(order, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[1])
  check('the label survives either arrival order', second.u === '把球体的记忆改成光点', second.u)

  // an injected-only turn records no label, and the counters show it
  emit(listeners, 'session/event', { id: 's12' }, onlyInjected)
  emit(listeners, 'session/event', { id: 's12' }, { type: 'turn/end', data: { turn: 3 } })
  const third = JSON.parse(readFileSync(join(order, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[2])
  check('an injected-only turn has no label', third.u === '', third.u)
}
// --- 11. the human prompt is read from the session when no user/message event arrives ---
{
  const sessionDir = join(root, 'session-label')
  const { ctx, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: sessionDir })
  const fakeSession = {
    id: 'session-xyz',
    deriveMessages() {
      return [
        { role: 'user', content: [{ type: 'text', text: '上一轮的话' }] },
        { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
        { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 2' }] },
        { role: 'user', content: [{ type: 'text', text: '这一轮的真人指令' }] },
      ]
    },
  }
  // no user/message event at all: only step/start, then the turn ends
  emit(listeners, 'session/event', fakeSession, { type: 'step/start', data: { turn: 2, step: 1 } })
  emit(listeners, 'session/event', fakeSession, { type: 'turn/end', data: { turn: 2 } })
  const row = JSON.parse(readFileSync(join(sessionDir, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[0])
  check('the label is read from the session at step start', row.u === '这一轮的真人指令', row.u)

  // a session without deriveMessages must not throw
  const noDerive = { id: 'session-noderive' }
  let threw = null
  try {
    emit(listeners, 'session/event', noDerive, { type: 'step/start', data: { turn: 3, step: 1 } })
    emit(listeners, 'session/event', noDerive, { type: 'turn/end', data: { turn: 3 } })
  } catch (error) {
    threw = error
  }
  check('a session without a message view does not throw', threw === null, threw === null ? null : String(threw.message))
}
// --- 12. the localized Mnemon snapshot must not become the label ---
{
  const dir = join(root, 'label-snapshot')
  const { ctx, listeners } = makeCtx()
  apply(ctx, { nodeCount: 300, chronicleDir: dir })
  const session = {
    id: 'session-snap',
    deriveMessages() {
      return [
        { role: 'user', content: [{ type: 'text', text: '以后备份都放到 D 盘' }] },
        { role: 'assistant', content: [{ type: 'text', text: '好' }] },
        {
          role: 'user',
          content: [{ type: 'text', text: 'MNEMON 运行时记忆快照\n条目注解默认为 importance=normal…\nUSER.md（用户画像）\n…' }],
        },
      ]
    },
  }
  emit(listeners, 'session/event', session, { type: 'step/start', data: { turn: 1, step: 1 } })
  emit(listeners, 'session/event', session, { type: 'turn/end', data: { turn: 1 } })
  const row = JSON.parse(readFileSync(join(dir, 'chronicle.jsonl'), 'utf8').split('\n').filter(Boolean)[0])
  check('a Chinese Mnemon snapshot is not the label', row.u === '以后备份都放到 D 盘', row.u)
}
rmSync(root, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
