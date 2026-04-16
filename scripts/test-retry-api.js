// Standalone smoke test for utils/retry-api.js
// Run: node scripts/test-retry-api.js
//
// Verifies:
//   1. Blocked-chat cache short-circuits send methods with synthetic 403
//   2. Non-send methods bypass the cache
//   3. clearBlockedChat removes the entry
//   4. withRetry honors retry_after and adds jitter
//   5. retryMiddleware clears the cache on incoming ctx.from
//   6. 403 "blocked by the user" response populates the cache

const assert = require('assert')
const Telegram = require('telegraf/telegram')

// Stub the underlying callApi BEFORE retry-api patches the prototype.
// retry-api wraps whatever callApi exists at require-time, so our stub
// becomes the "real" network layer.
const calls = []
let stubResponder = () => Promise.resolve({ ok: true })
Telegram.prototype.callApi = function (method, data) {
  calls.push({ method, data })
  return stubResponder(method, data)
}

const {
  clearBlockedChat,
  retryMiddleware,
  _blockedCacheSize
} = require('../utils/retry-api')

const tg = new Telegram('fake-token')

// Access the cache via the module's internal Map by re-requiring it —
// we need a way to fully reset between tests. Simplest: export a reset.
// If we don't want to expand the public surface, iterate the cache via
// the size helper and clear by calling clearBlockedChat for the chat_ids
// we touched. For this smoke test we just track them explicitly.
const touchedChats = new Set()
function touch (chatId) {
  touchedChats.add(chatId)
  return chatId
}
function resetCache () {
  for (const id of touchedChats) clearBlockedChat(id)
  touchedChats.clear()
}

async function test (name, fn) {
  try {
    calls.length = 0
    stubResponder = () => Promise.resolve({ ok: true })
    resetCache()
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (err) {
    console.error(`  FAIL  ${name}`)
    console.error(err.stack || err.message)
    process.exitCode = 1
  } finally {
    resetCache()
  }
}

;(async () => {
  console.log('retry-api.js smoke test')

  await test('non-send methods bypass the cache entirely', async () => {
    stubResponder = () => {
      const err = new Error('Forbidden: bot was blocked by the user')
      err.code = 403
      err.description = 'Forbidden: bot was blocked by the user'
      return Promise.reject(err)
    }
    await assert.rejects(tg.callApi('getMe', {}))
    assert.strictEqual(calls.length, 1, 'getMe should still hit stub')
    assert.strictEqual(_blockedCacheSize(), 0, 'non-send 403 should not cache')
  })

  await test('403 blocked on sendMessage caches the chat_id', async () => {
    stubResponder = () => {
      const err = new Error('Forbidden: bot was blocked by the user')
      err.code = 403
      err.description = 'Forbidden: bot was blocked by the user'
      return Promise.reject(err)
    }
    await assert.rejects(tg.callApi('sendMessage', { chat_id: touch(111), text: 'x' }))
    assert.strictEqual(_blockedCacheSize(), 1)

    // Next send to same chat must short-circuit — stub call count stays at 1
    await assert.rejects(tg.callApi('sendMessage', { chat_id: 111, text: 'y' }))
    assert.strictEqual(calls.length, 1, 'cached block should skip real call')
  })

  await test('non-send 403 (createNewStickerSet) also caches the user_id', async () => {
    stubResponder = () => {
      const err = new Error('Forbidden: bot was blocked by the user')
      err.code = 403
      err.description = 'Forbidden: bot was blocked by the user'
      return Promise.reject(err)
    }
    // Rationale: if ANY call involving this user returns "user blocked
    // the bot", subsequent sendMessage/etc. to the same chat_id will
    // fail for the same reason. Cache defensively on all 403 blocked.
    await assert.rejects(tg.callApi('createNewStickerSet', { user_id: touch(222) }))
    assert.strictEqual(_blockedCacheSize(), 1)

    // Now the scene-style follow-up sendMessage short-circuits
    await assert.rejects(tg.callApi('sendMessage', { chat_id: 222, text: 'err' }))
    assert.strictEqual(calls.length, 1, 'follow-up send must not hit network')
  })

  await test('cascade scenario: send fails, second send short-circuits', async () => {
    stubResponder = () => {
      const err = new Error('Forbidden: bot was blocked by the user')
      err.code = 403
      err.description = 'Forbidden: bot was blocked by the user'
      return Promise.reject(err)
    }
    await assert.rejects(tg.callApi('sendMessage', { chat_id: touch(333), text: 'err1' }))
    assert.strictEqual(calls.length, 1)
    await assert.rejects(tg.callApi('sendMessage', { chat_id: 333, text: 'err2' }))
    assert.strictEqual(calls.length, 1, 'second send must not hit network')
  })

  await test('withRetry honors retry_after and completes on success', async () => {
    let attempts = 0
    stubResponder = () => {
      attempts++
      if (attempts === 1) {
        const err = new Error('Too Many Requests')
        err.code = 429
        err.description = 'Too Many Requests: retry after 1'
        err.parameters = { retry_after: 1 }
        return Promise.reject(err)
      }
      return Promise.resolve({ ok: true, message_id: 1 })
    }
    const start = Date.now()
    const result = await tg.callApi('sendMessage', { chat_id: 444, text: 'x' })
    const elapsed = Date.now() - start
    assert.strictEqual(result.ok, true)
    assert.strictEqual(attempts, 2, 'should retry once after 429')
    assert.ok(elapsed >= 1000, `expected >= 1000ms, got ${elapsed}ms (jitter lower bound)`)
    assert.ok(elapsed < 3000, `expected < 3000ms, got ${elapsed}ms (jitter upper bound)`)
  })

  await test('429 with retry_after > maxWait throws immediately (uniform fail-fast)', async () => {
    let attempts = 0
    stubResponder = () => {
      attempts++
      const err = new Error('Too Many Requests')
      err.code = 429
      err.description = 'Too Many Requests: retry after 40'
      err.parameters = { retry_after: 40 }
      return Promise.reject(err)
    }
    const start = Date.now()
    await assert.rejects(tg.callApi('sendMessage', { chat_id: 888, text: 'x' }))
    const elapsed = Date.now() - start
    assert.strictEqual(attempts, 1, 'must NOT retry when retry_after exceeds maxWait')
    assert.ok(elapsed < 200, `must fail fast — got ${elapsed}ms`)
  })

  await test('429 with retry_after <= maxWait retries regardless of method', async () => {
    let attempts = 0
    stubResponder = () => {
      attempts++
      if (attempts < 2) {
        const err = new Error('Too Many Requests')
        err.code = 429
        err.description = 'Too Many Requests: retry after 1'
        err.parameters = { retry_after: 1 }
        return Promise.reject(err)
      }
      return Promise.resolve({ ok: true })
    }
    const result = await tg.callApi('addStickerToSet', { user_id: 999, name: 'pack' })
    assert.strictEqual(result.ok, true, 'short retry_after should retry and succeed for any method')
    assert.strictEqual(attempts, 2, 'should retry once then succeed')
  })

  await test('withRetry honors custom maxWait for direct (non-patched) calls', async () => {
    // Background workers can pass their own maxWait to withRetry when
    // they wrap non-Telegram async work. This validates the options
    // override path — we don't go through tg.callApi here because the
    // prototype patch applies its own withRetry and we'd nest them.
    const { withRetry } = require('../utils/retry-api')
    let attempts = 0
    const start = Date.now()
    await assert.rejects(withRetry(async () => {
      attempts++
      const err = new Error('Too Many Requests')
      err.code = 429
      err.description = 'Too Many Requests: retry after 2'
      err.parameters = { retry_after: 2 }
      throw err
    }, { method: 'addStickerToSet', maxRetries: 1, maxWait: 10 }))
    const elapsed = Date.now() - start
    // maxRetries=1 → 2 total attempts; retry_after=2s ≤ maxWait=10 → 1 wait
    assert.strictEqual(attempts, 2, 'should retry exactly once')
    assert.ok(elapsed >= 2000, `should wait ~2s between attempts — got ${elapsed}ms`)
    assert.ok(elapsed < 5000, `but not unreasonably long — got ${elapsed}ms`)
  })

  await test('retryMiddleware clears cache for incoming user', async () => {
    stubResponder = () => {
      const err = new Error('Forbidden: bot was blocked by the user')
      err.code = 403
      err.description = 'Forbidden: bot was blocked by the user'
      return Promise.reject(err)
    }
    await assert.rejects(tg.callApi('sendMessage', { chat_id: touch(555), text: 'x' }))
    assert.strictEqual(_blockedCacheSize(), 1)

    const mw = retryMiddleware()
    const ctx = { from: { id: 555 }, chat: { id: 555 }, update: {} }
    await mw(ctx, async () => {})
    assert.strictEqual(_blockedCacheSize(), 0, 'middleware should clear cache')
  })

  await test('synthetic 403 carries __cachedBlock flag for catch.js to skip', async () => {
    stubResponder = () => {
      const err = new Error('Forbidden: bot was blocked by the user')
      err.code = 403
      err.description = 'Forbidden: bot was blocked by the user'
      return Promise.reject(err)
    }
    // First call: real network 403, populates cache, error has no flag
    let firstErr
    try { await tg.callApi('sendMessage', { chat_id: touch(777), text: 'x' }) } catch (e) { firstErr = e }
    assert.strictEqual(firstErr.__cachedBlock, undefined,
      'real 403 must NOT be marked as cached — catch.js should still log it')

    // Second call: short-circuited, must carry the flag so catch.js
    // can silently drop it instead of spamming the admin log channel
    let secondErr
    try { await tg.callApi('sendMessage', { chat_id: 777, text: 'y' }) } catch (e) { secondErr = e }
    assert.strictEqual(secondErr.__cachedBlock, true,
      'cached short-circuit must set __cachedBlock = true')
    assert.strictEqual(secondErr.code, 403)
  })

  await test('group 403 (negative chat_id) is NOT cached — permission errors ≠ blocked', async () => {
    stubResponder = () => {
      const err = new Error('Forbidden: not enough rights')
      err.code = 403
      err.description = 'Forbidden: not enough rights to send text messages'
      return Promise.reject(err)
    }
    await assert.rejects(tg.callApi('sendMessage', { chat_id: -1001234, text: 'x' }))
    assert.strictEqual(_blockedCacheSize(), 0, 'negative chat_id (group) must not populate cache')
  })

  await test('429 retry_after on error.response.parameters path also triggers retry', async () => {
    let attempts = 0
    stubResponder = () => {
      attempts++
      if (attempts === 1) {
        const err = new Error('Too Many Requests')
        err.code = 429
        err.response = { parameters: { retry_after: 1 } }
        return Promise.reject(err)
      }
      return Promise.resolve({ ok: true })
    }
    const result = await tg.callApi('sendMessage', { chat_id: 1234, text: 'x' })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(attempts, 2, 'should retry using response.parameters.retry_after')
  })

  await test('retryMiddleware ignores kick events', async () => {
    const mw = retryMiddleware()
    const ctx = {
      from: { id: 666 },
      chat: { id: 666 },
      update: {
        my_chat_member: { new_chat_member: { status: 'kicked' } }
      }
    }
    // Pre-cache — a kick should NOT clear (user really did block us)
    stubResponder = () => {
      const err = new Error('Forbidden')
      err.code = 403
      err.description = 'Forbidden: bot was blocked by the user'
      return Promise.reject(err)
    }
    await assert.rejects(tg.callApi('sendMessage', { chat_id: touch(666), text: 'x' }))
    const sizeBefore = _blockedCacheSize()
    await mw(ctx, async () => {})
    assert.strictEqual(_blockedCacheSize(), sizeBefore, 'kick must not clear cache')
  })

  if (process.exitCode) {
    console.error('\nsmoke test FAILED')
  } else {
    console.log('\nsmoke test OK')
  }
})()
