/**
 * Contract-level checks for the IPC router.
 *
 * Runs in plain Node against the built main bundle's routing core, so it needs
 * no Electron window and no display. Folded into the vitest suite in #12.
 */
import { invokeChannel } from '../out/main/router.js'
import { unwrap } from './build/renderer-ipc.js'

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
}

const handlers = {
  'app:getInfo': () => ({
    name: 'Forge',
    version: '0.0.1',
    platform: 'test',
    versions: { electron: 'x', chrome: 'y', node: 'z' },
  }),
}

// A channel outside the contract must be refused by name, before any handler
// lookup — this is the guarantee that makes the allowlist meaningful.
const unknown = await invokeChannel(handlers, 'fs:readFile', { path: 'C:/secrets' })
check(
  'unregistered channel is rejected',
  unknown.ok === false && unknown.code === 'UNKNOWN_CHANNEL',
  JSON.stringify(unknown),
)

// A declared channel with a malformed payload must fail validation rather than
// reaching the handler.
const badRequest = await invokeChannel(handlers, 'app:getInfo', { unexpected: true })
check(
  'unknown keys in a request are rejected',
  badRequest.ok === false && badRequest.code === 'INVALID_REQUEST',
  JSON.stringify(badRequest),
)

// A handler returning the wrong shape must fail here, not corrupt the renderer.
const badResponse = await invokeChannel(
  { 'app:getInfo': () => ({ name: 'Forge' }) },
  'app:getInfo',
  {},
)
check(
  'malformed handler response is rejected',
  badResponse.ok === false && badResponse.code === 'INVALID_RESPONSE',
  JSON.stringify(badResponse),
)

// A throwing handler must be reported as a failure, never as a crash.
const threw = await invokeChannel(
  {
    'app:getInfo': () => {
      throw new Error('boom')
    },
  },
  'app:getInfo',
  {},
)
check(
  'handler exception becomes a failure envelope',
  threw.ok === false && threw.code === 'HANDLER_FAILED' && threw.message.includes('boom'),
  JSON.stringify(threw),
)

// The happy path still works.
const ok = await invokeChannel(handlers, 'app:getInfo', {})
check('valid call succeeds', ok.ok === true && ok.value.name === 'Forge', JSON.stringify(ok))

// The renderer-side unwrap turns a failure envelope into a typed error, and
// passes a success through untouched.
let unwrapped = null
let unwrapError = null
try {
  unwrapped = unwrap(ok)
} catch (error) {
  unwrapError = error
}
check(
  'unwrap passes a success value through',
  unwrapError === null && unwrapped.name === 'Forge',
  String(unwrapError),
)

let thrownByUnwrap = null
try {
  unwrap(unknown)
} catch (error) {
  thrownByUnwrap = error
}
check(
  'unwrap converts a failure envelope into a typed error',
  thrownByUnwrap instanceof Error &&
    thrownByUnwrap.name === 'ForgeIpcError' &&
    thrownByUnwrap.code === 'UNKNOWN_CHANNEL',
  `${thrownByUnwrap?.name} / ${thrownByUnwrap?.code}`,
)

for (const { name, pass, detail } of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  (${detail})`}`)
}

const failed = checks.filter((c) => !c.pass).length
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)
