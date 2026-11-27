// Host-runtime import guard.
//
// The test suite usually runs on PATH Node, but the plugin actually loads in
// the Desktop host, whose Node version is stricter about named exports (a
// `W_OK` import from `node:fs` passed on Node 22 and failed activation on the
// host's Node 24). This smoke imports the module under both runtimes.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const results = []
function check(label, ok, extra) {
  results.push({ label, ok, extra })
}

// 1. the current runtime can import the entry module
const local = await import('../index.js')
check('entry module exports apply', typeof local.apply === 'function', typeof local.apply)
check('entry module exports inject', Array.isArray(local.inject), local.inject)

// 2. the DSH host runtime can import it too, when its executable is known
const hostNode = process.env.DSH_NODE_EXECUTABLE
if (!hostNode) {
  check('host runtime import skipped (DSH_NODE_EXECUTABLE unset)', true, 'skipped')
} else {
  const entry = new URL('../index.js', import.meta.url).href
  const script = 'import(' + JSON.stringify(entry) + ').then((m) => { console.log("IMPORT_OK", typeof m.apply) }).catch((err) => { console.log("IMPORT_FAIL", err && err.message); process.exitCode = 1 })'
  const run = spawnSync(hostNode, ['--input-type=module', '-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60000,
  })
  const out = String(run.stdout || '')
  check('host runtime imports the entry module', out.includes('IMPORT_OK function'), out.trim().slice(0, 200) || String(run.stderr || '').slice(0, 200))
  check('host runtime exits cleanly', run.status === 0, run.status)
}

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.extra === undefined ? '' : '  [' + JSON.stringify(r.extra) + ']'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
