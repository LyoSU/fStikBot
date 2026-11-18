// Unit tests for utils/inflight-adds.js — the (pack, file) claim that keeps a
// file sent twice while the first copy is still converting out of the pack.

const assert = require('assert')
const inflight = require('../utils/inflight-adds')

let passed = 0
let failed = 0

function test (name, fn) {
  inflight._clear()
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

test('the same file into the same pack is refused while the first add runs', () => {
  const key = inflight.claim('pack1', 'fileA')
  assert.ok(key)
  assert.strictEqual(inflight.claim('pack1', 'fileA'), false)
})

test('released claim can be taken again', () => {
  const key = inflight.claim('pack1', 'fileA')
  inflight.release(key)
  assert.ok(inflight.claim('pack1', 'fileA'))
})

test('another pack or another file is independent', () => {
  assert.ok(inflight.claim('pack1', 'fileA'))
  assert.ok(inflight.claim('pack2', 'fileA'))
  assert.ok(inflight.claim('pack1', 'fileB'))
})

test('a claim nobody released expires on its own', () => {
  const now = 1000
  assert.ok(inflight.claim('pack1', 'fileA', { now, ttlMs: 50 }))
  assert.strictEqual(inflight.claim('pack1', 'fileA', { now: now + 10, ttlMs: 50 }), false)
  assert.ok(inflight.claim('pack1', 'fileA', { now: now + 51, ttlMs: 50 }))
})

test('nothing to key on: no claim and no refusal', () => {
  assert.strictEqual(inflight.claim('pack1', undefined), null)
  assert.strictEqual(inflight.claim(null, 'fileA'), null)
  inflight.release(null)
})

test('a late release of an expired claim does not free the newer one', () => {
  const old = inflight.claim('p', 'f', { now: 0, ttlMs: 10 })
  const fresh = inflight.claim('p', 'f', { now: 20, ttlMs: 1000 })
  assert.ok(old && fresh && old !== fresh)
  inflight.release(old)
  assert.strictEqual(inflight.claim('p', 'f', { now: 30 }), false, 'the newer claim still holds')
  inflight.release(fresh)
  assert.ok(inflight.claim('p', 'f', { now: 30 }))
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('inflight-adds test OK')
