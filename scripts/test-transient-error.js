// Unit tests for utils/transient-error.js: which failures leave a call's
// outcome unknown (a dropped connection, a Telegram 5xx).

const assert = require('assert')
const { isNetworkError, isServerError, isTransientError } = require('../utils/transient-error')

const fetchError = () => Object.assign(new Error('request to https://api.telegram.org/bot<redacted>/uploadStickerFile failed, reason: '), { name: 'FetchError', type: 'system' })
const telegramError = (code) => Object.assign(new Error(`${code}: Bad Request`), { code, description: 'Bad Request' })

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']) {
  assert.ok(isNetworkError(Object.assign(new Error('x'), { code })), code)
}
assert.ok(isNetworkError(new Error('socket hang up')))
assert.ok(isNetworkError(new Error('Client network socket disconnected before secure TLS connection')))
assert.ok(isNetworkError(fetchError()))
assert.ok(!isNetworkError(telegramError(400)), 'a Telegram answer is not a network error')
assert.ok(!isNetworkError(new Error('something else')))
assert.ok(!isNetworkError(null))

for (const code of [500, 502, 503, 504]) assert.ok(isServerError(telegramError(code)), String(code))
assert.ok(isServerError({ response: { error_code: 502 } }))
assert.ok(isServerError(telegramError(507)), 'any 5xx')
assert.ok(!isServerError(telegramError(429)) && !isServerError(telegramError(400)))

assert.ok(isTransientError(fetchError()) && isTransientError(telegramError(504)))
assert.ok(!isTransientError(telegramError(429)), 'a 429 is an answer: Telegram did nothing')

console.log('transient-error test OK')
