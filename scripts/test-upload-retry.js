// Unit tests for utils/upload-retry.js — network-level retry of
// uploadStickerFile. No network; backoff is zero so the tests stay fast.

const assert = require('assert')
const { uploadStickerFile, isNetworkError } = require('../utils/upload-retry')

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${error.message}`)
  }
}

const fetchError = () => Object.assign(new Error('request to https://api.telegram.org/bot<redacted>/uploadStickerFile failed, reason: '), { name: 'FetchError', type: 'system' })
const telegramError = (code) => Object.assign(new Error(`${code}: Bad Request`), { code, description: 'Bad Request' })

// Fake client: each call takes the next step (an Error is thrown, else returned).
const client = (...steps) => {
  const fake = {
    calls: 0,
    callApi: async () => {
      const step = steps[Math.min(fake.calls++, steps.length - 1)]
      if (step instanceof Error) throw step
      return step
    }
  }
  return fake
}
const opts = () => ({ delaysMs: [0, 0], onRetry: () => { opts.retries++ } })
opts.retries = 0

const main = async () => {
  await test('network error then success returns the uploaded file', async () => {
    const fake = client(fetchError(), { file_id: 'abc' })
    opts.retries = 0
    const result = await uploadStickerFile(fake, {}, opts())
    assert.deepStrictEqual(result, { file_id: 'abc' })
    assert.strictEqual(fake.calls, 2)
    assert.strictEqual(opts.retries, 1)
  })

  await test('network error 3 times fails after exactly 3 calls', async () => {
    const err = fetchError()
    const fake = client(err)
    const result = await uploadStickerFile(fake, {}, opts())
    assert.strictEqual(fake.calls, 3)
    assert.strictEqual(result.error.telegram, err)
  })

  await test('a 400 Telegram error is not retried', async () => {
    const err = telegramError(400)
    const fake = client(err)
    const result = await uploadStickerFile(fake, {}, opts())
    assert.strictEqual(fake.calls, 1)
    assert.strictEqual(result.error.telegram, err)
  })

  await test('429 and 5xx stay with retry-api: no retry here', async () => {
    for (const code of [429, 502]) {
      const fake = client(telegramError(code))
      await uploadStickerFile(fake, {}, opts())
      assert.strictEqual(fake.calls, 1)
    }
  })

  await test('isNetworkError recognises socket errors, not Telegram answers', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']) {
      assert.ok(isNetworkError(Object.assign(new Error('x'), { code })), code)
    }
    assert.ok(isNetworkError(new Error('socket hang up')))
    assert.ok(isNetworkError(new Error('Client network socket disconnected before secure TLS connection')))
    assert.ok(isNetworkError(fetchError()))
    assert.ok(!isNetworkError(telegramError(400)))
    assert.ok(!isNetworkError(new Error('something else')))
    assert.ok(!isNetworkError(null))
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
  console.log('upload-retry test OK')
}

main()
