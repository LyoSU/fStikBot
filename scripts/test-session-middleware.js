// Standalone smoke test for bot/session-store.js sessionMiddleware.
// Run: node scripts/test-session-middleware.js
//
// Verifies:
//   1. Loads session from fake store and exposes ctx.session
//   2. userInfo is stripped from the written payload
//   3. No mutation → no store.set call (dirty-check)
//   4. Anonymous updates (no ctx.from) → next() runs, no session work
//   5. Legacy `{ session, expires }` format is unwrapped on read

const assert = require('assert')
const {
  sessionMiddleware,
  getSessionKey,
  _internal
} = require('../bot/session-store')

function makeFakeStore (initial = new Map()) {
  const store = initial
  const calls = { get: 0, set: 0, del: 0, lastSet: null }
  return {
    store,
    calls,
    impl: {
      get: async (key) => { calls.get++; return store.get(key) },
      set: async (key, value) => { calls.set++; calls.lastSet = { key, value }; store.set(key, value) },
      del: async (key) => { calls.del++; store.delete(key) }
    }
  }
}

async function test (name, fn) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err.stack || err.message)
    process.exitCode = 1
  } finally {
    _internal.resetImpl()
  }
}

;(async () => {
  console.log('session-store.js middleware smoke test')

  await test('loads session from store and exposes ctx.session', async () => {
    const fake = makeFakeStore(new Map([['user:1', { foo: 'bar', count: 3 }]]))
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 1 }, chat: { id: 1 } }
    let seen
    await mw(ctx, async () => { seen = ctx.session })
    assert.deepStrictEqual(seen, { foo: 'bar', count: 3 })
    assert.strictEqual(fake.calls.get, 1)
  })

  await test('userInfo is NOT persisted to the store', async () => {
    const fake = makeFakeStore()
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 2 }, chat: { id: 2 } }
    await mw(ctx, async () => {
      ctx.session.userInfo = { _id: 'deadbeef', populated: { ref: 'huge' } }
      ctx.session.scene = 'uploadSticker'
    })
    assert.strictEqual(fake.calls.set, 1, 'scene mutation should trigger write')
    const written = fake.calls.lastSet.value
    assert.strictEqual(written.userInfo, undefined, 'userInfo must be stripped')
    assert.strictEqual(written.scene, 'uploadSticker', 'other fields persist')
  })

  await test('setting only userInfo counts as no dirty change (dirty-check)', async () => {
    const fake = makeFakeStore(new Map([['user:3', { scene: 'x' }]]))
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 3 }, chat: { id: 3 } }
    await mw(ctx, async () => {
      // Simulate updateUser — only touches userInfo
      ctx.session.userInfo = { mongoose: 'doc' }
    })
    assert.strictEqual(fake.calls.set, 0, 'userInfo-only change must NOT trigger write')
  })

  await test('no mutation at all → no store.set call', async () => {
    const fake = makeFakeStore(new Map([['user:4', { scene: 'y', n: 1 }]]))
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 4 }, chat: { id: 4 } }
    await mw(ctx, async () => {
      // Read-only access
      const _ = ctx.session.scene
      assert.strictEqual(_, 'y')
    })
    assert.strictEqual(fake.calls.set, 0, 'pure read must not write')
  })

  await test('real mutation does trigger store.set', async () => {
    const fake = makeFakeStore()
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 5 }, chat: { id: 5 } }
    await mw(ctx, async () => {
      ctx.session.scene = 'new'
    })
    assert.strictEqual(fake.calls.set, 1)
    assert.deepStrictEqual(fake.calls.lastSet.value, { scene: 'new' })
  })

  await test('anonymous update (no ctx.from) → next() runs, no store touched', async () => {
    const fake = makeFakeStore()
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { update: { update_id: 999 } } // no from, no chat
    let called = false
    await mw(ctx, async () => { called = true })
    assert.strictEqual(called, true, 'next must still run')
    assert.strictEqual(fake.calls.get, 0, 'no get on anonymous')
    assert.strictEqual(fake.calls.set, 0, 'no set on anonymous')
    assert.strictEqual(ctx.session, undefined, 'ctx.session not defined')
    assert.strictEqual(getSessionKey(ctx), undefined)
  })

  await test('legacy {session, expires} format is unwrapped on read', async () => {
    const fake = makeFakeStore(new Map([
      ['user:6', { session: { scene: 'legacy', count: 7 }, expires: null }]
    ]))
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 6 }, chat: { id: 6 } }
    let seen
    await mw(ctx, async () => { seen = ctx.session })
    assert.deepStrictEqual(seen, { scene: 'legacy', count: 7 })
  })

  await test('legacy {session, expires} → subsequent write uses new raw format', async () => {
    const fake = makeFakeStore(new Map([
      ['user:7', { session: { scene: 'legacy' }, expires: null }]
    ]))
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 7 }, chat: { id: 7 } }
    await mw(ctx, async () => {
      ctx.session.scene = 'migrated'
    })
    assert.strictEqual(fake.calls.set, 1)
    // New format: raw session, no wrapper
    assert.deepStrictEqual(fake.calls.lastSet.value, { scene: 'migrated' })
    assert.strictEqual(fake.calls.lastSet.value.session, undefined)
    assert.strictEqual(fake.calls.lastSet.value.expires, undefined)
  })

  await test('object with a `session` key but other top-level keys is NOT unwrapped', async () => {
    // Conservative unwrap: if there are keys other than session/expires it's
    // a real user session that happens to contain a `session` field.
    const fake = makeFakeStore(new Map([
      ['user:8', { session: 'not-a-wrapper', foo: 'bar' }]
    ]))
    _internal.setImpl(fake.impl)
    const mw = sessionMiddleware()
    const ctx = { from: { id: 8 }, chat: { id: 8 } }
    let seen
    await mw(ctx, async () => { seen = ctx.session })
    assert.deepStrictEqual(seen, { session: 'not-a-wrapper', foo: 'bar' })
  })

  await test('serializeWithoutUserInfo drops userInfo only', () => {
    const s = _internal.serializeWithoutUserInfo({
      scene: 'x',
      userInfo: { huge: 'doc' },
      counter: 3
    })
    const parsed = JSON.parse(s)
    assert.strictEqual(parsed.userInfo, undefined)
    assert.strictEqual(parsed.scene, 'x')
    assert.strictEqual(parsed.counter, 3)
  })

  await test('getSessionKey: private chat → user:<id>', () => {
    assert.strictEqual(getSessionKey({ from: { id: 42 }, chat: { id: 42 } }), 'user:42')
  })
  await test('getSessionKey: group → <from>:<chat>', () => {
    assert.strictEqual(getSessionKey({ from: { id: 42 }, chat: { id: -100 } }), '42:-100')
  })

  if (process.exitCode) {
    console.error('\nsmoke test FAILED')
  } else {
    console.log('\nsmoke test OK')
  }
  // Force-exit: the Redis client inside session-store.js opens a connection
  // at require-time and keeps the event loop alive. No graceful close on
  // the module — exit directly so the test doesn't hang.
  process.exit(process.exitCode || 0)
})()
