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
  runInCopyScope,
  _blockedCacheSize,
  _rateLimitCacheSize
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

  await test('429 with retry_after > maxWait caches (method, chat) — siblings short-circuit', async () => {
    let attempts = 0
    stubResponder = () => {
      attempts++
      const err = new Error('Too Many Requests')
      err.code = 429
      err.description = 'Too Many Requests: retry after 7'
      err.parameters = { retry_after: 7 }
      return Promise.reject(err)
    }
    // First call: real network 429, fails fast, populates rate-limit cache
    let firstErr
    try { await tg.callApi('sendChatAction', { chat_id: 1001, action: 'upload_document' }) } catch (e) { firstErr = e }
    assert.strictEqual(attempts, 1, 'first call must hit the network')
    assert.strictEqual(firstErr.__cachedRateLimit, undefined, 'real 429 not marked as cached')
    assert.ok(_rateLimitCacheSize() >= 1, 'cache must populate after fail-fast 429')

    // Second call same (method, chat): short-circuits, zero network
    let secondErr
    try { await tg.callApi('sendChatAction', { chat_id: 1001, action: 'upload_document' }) } catch (e) { secondErr = e }
    assert.strictEqual(attempts, 1, 'cached short-circuit must not hit network')
    assert.strictEqual(secondErr.__cachedRateLimit, true, 'synthetic error carries flag for catch.js')
    assert.strictEqual(secondErr.code, 429)

    // Different chat_id for same method: not in cache — must hit network
    let thirdErr
    try { await tg.callApi('sendChatAction', { chat_id: 1002, action: 'upload_document' }) } catch (e) { thirdErr = e }
    assert.strictEqual(attempts, 2, 'different chat must not inherit cooldown')
    assert.strictEqual(thirdErr.__cachedRateLimit, undefined, 'different chat gets real 429')
  })

  await test('429 with retry_after > maxWait caches by pack name — siblings on same pack short-circuit', async () => {
    let attempts = 0
    stubResponder = () => {
      attempts++
      const err = new Error('Too Many Requests')
      err.code = 429
      err.description = 'Too Many Requests: retry after 8'
      err.parameters = { retry_after: 8 }
      return Promise.reject(err)
    }
    // Pack A: real 429, fails fast, populates (method, name) cache.
    let firstErr
    try { await tg.callApi('setStickerSetTitle', { name: 'pack_a', title: 'X' }) } catch (e) { firstErr = e }
    assert.strictEqual(attempts, 1, 'first call must hit the network')
    assert.strictEqual(firstErr.__cachedRateLimit, undefined, 'real 429 not marked as cached')

    // Same pack name → short-circuited.
    let secondErr
    try { await tg.callApi('setStickerSetTitle', { name: 'pack_a', title: 'Y' }) } catch (e) { secondErr = e }
    assert.strictEqual(attempts, 1, 'cached short-circuit must not hit network for same pack')
    assert.strictEqual(secondErr.__cachedRateLimit, true, 'synthetic error carries flag')

    // Different pack: per-pack scope is not shared, must hit network.
    let thirdErr
    try { await tg.callApi('setStickerSetTitle', { name: 'pack_b', title: 'Z' }) } catch (e) { thirdErr = e }
    assert.strictEqual(attempts, 2, 'different pack must not inherit cooldown')
    assert.strictEqual(thirdErr.__cachedRateLimit, undefined, 'different pack gets real 429')
  })

  await test('429 without chat/user/pack scope does NOT cache (no global method-only lockout)', async () => {
    // Regression: deleteStickerFromSet payload is { sticker: file_id } — no
    // chat_id / user_id. A single per-pack 429 with retry_after > maxWait
    // must NOT cache the method globally; doing so would block every other
    // user's deleteStickerFromSet for the entire retry_after window.
    let attempts = 0
    stubResponder = () => {
      attempts++
      const err = new Error('Too Many Requests')
      err.code = 429
      err.description = 'Too Many Requests: retry after 30'
      err.parameters = { retry_after: 30 }
      return Promise.reject(err)
    }
    const sizeBefore = _rateLimitCacheSize()
    await assert.rejects(tg.callApi('deleteStickerFromSet', { sticker: 'file_a' }))
    assert.strictEqual(attempts, 1, 'first call must hit the network and fail-fast')
    assert.strictEqual(_rateLimitCacheSize(), sizeBefore, 'scopeless 429 must not populate cache')

    // Second call (different sticker, same method): must also hit network,
    // not be short-circuited by a stale method-only cache entry.
    await assert.rejects(tg.callApi('deleteStickerFromSet', { sticker: 'file_b' }))
    assert.strictEqual(attempts, 2, 'second call must hit network — no stale method-only lock')
  })

  await test('429 cache only triggers when retry_after > maxWait (not for retriable 429s)', async () => {
    // retry_after=2s is ≤ default maxWait=5s → withRetry retries and succeeds.
    // We must NOT cache a transient 429 that retry already solved, otherwise
    // every subsequent legit call would synthetically 429.
    let attempts = 0
    stubResponder = () => {
      attempts++
      if (attempts === 1) {
        const err = new Error('Too Many Requests')
        err.code = 429
        err.parameters = { retry_after: 2 }
        return Promise.reject(err)
      }
      return Promise.resolve({ ok: true })
    }
    const sizeBefore = _rateLimitCacheSize()
    const result = await tg.callApi('sendMessage', { chat_id: 2001, text: 'x' })
    assert.strictEqual(result.ok, true)
    assert.strictEqual(_rateLimitCacheSize(), sizeBefore, 'retriable 429 must not populate cache')
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

  await test('copy scope: 429 does NOT write the cooldown cache (no cascade poison)', async () => {
    // Inside a copy, a fail-fast 429 must not populate the cache — otherwise
    // one long 429 would cascade-fail every remaining sticker of the copy.
    stubResponder = () => {
      const err = new Error('Too Many Requests')
      err.code = 429
      err.description = 'Too Many Requests: retry after 90'
      err.parameters = { retry_after: 90 } // > COPY_RETRY_MAX_WAIT_S
      return Promise.reject(err)
    }
    const sizeBefore = _rateLimitCacheSize()
    await assert.rejects(runInCopyScope(() =>
      tg.callApi('uploadStickerFile', { user_id: 3001, sticker_format: 'static' })))
    assert.strictEqual(_rateLimitCacheSize(), sizeBefore, 'copy-scope 429 must not populate cache')
  })

  await test('copy scope: does NOT read a pre-existing cooldown (not short-circuited)', async () => {
    // Prime a real cooldown for (uploadStickerFile, user 3002) via a normal
    // (non-copy) fail-fast 429, then a copy-scope call to the same pair must
    // still hit the network instead of getting a synthetic cached 429.
    let attempts = 0
    stubResponder = () => {
      attempts++
      const err = new Error('Too Many Requests')
      err.code = 429
      err.description = 'Too Many Requests: retry after 40'
      err.parameters = { retry_after: 40 }
      return Promise.reject(err)
    }
    // Non-copy call populates the cache.
    await assert.rejects(tg.callApi('uploadStickerFile', { user_id: 3002, sticker_format: 'static' }))
    assert.strictEqual(attempts, 1, 'priming call hits network')

    // Copy-scope call to same (method, user) must bypass the cache read.
    let copyErr
    try {
      await runInCopyScope(() =>
        tg.callApi('uploadStickerFile', { user_id: 3002, sticker_format: 'static' }))
    } catch (e) { copyErr = e }
    assert.strictEqual(attempts, 2, 'copy-scope call must hit network, not short-circuit')
    assert.strictEqual(copyErr.__cachedRateLimit, undefined, 'copy-scope must not get synthetic cached 429')
    // No cleanup needed: the rate-limit cooldown is keyed by (method, id)
    // and every test here uses a unique id, so it can't leak sideways.
  })

  await test('copy scope: retries a 429 that exceeds default maxWait but is within COPY_RETRY_MAX_WAIT_S', async () => {
    // retry_after=6s > default maxWait (5s) → a normal call would fail fast.
    // Inside a copy scope, maxWait is 30s, so it must wait and succeed.
    let attempts = 0
    stubResponder = () => {
      attempts++
      if (attempts === 1) {
        const err = new Error('Too Many Requests')
        err.code = 429
        err.parameters = { retry_after: 6 }
        return Promise.reject(err)
      }
      return Promise.resolve({ ok: true })
    }
    const start = Date.now()
    const result = await runInCopyScope(() =>
      tg.callApi('addStickerToSet', { user_id: 3003, name: 'pack' }))
    const elapsed = Date.now() - start
    assert.strictEqual(result.ok, true, 'copy-scope should retry a 6s 429 and succeed')
    assert.strictEqual(attempts, 2, 'should retry exactly once')
    assert.ok(elapsed >= 6000, `should wait ~6s before retry — got ${elapsed}ms`)
  })

  await test('copy scope does NOT leak: after it returns, default fail-fast policy resumes', async () => {
    // A call made outside any copy scope must keep the strict 5s maxWait —
    // AsyncLocalStorage must not bleed the copy policy into later calls.
    let attempts = 0
    stubResponder = () => {
      attempts++
      const err = new Error('Too Many Requests')
      err.code = 429
      err.parameters = { retry_after: 6 } // > default maxWait, ≤ copy maxWait
      return Promise.reject(err)
    }
    const start = Date.now()
    await assert.rejects(tg.callApi('sendMessage', { chat_id: 3004, text: 'x' }))
    const elapsed = Date.now() - start
    assert.strictEqual(attempts, 1, 'outside copy scope must fail fast on a 6s 429')
    assert.ok(elapsed < 500, `must not wait — got ${elapsed}ms`)
  })

  if (process.exitCode) {
    console.error('\nsmoke test FAILED')
  } else {
    console.log('\nsmoke test OK')
  }
})()
