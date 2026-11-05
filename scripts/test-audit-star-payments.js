// Unit tests for scripts/audit-star-payments.js. No network and no database.

const assert = require('assert')
const { splitTransactions, classify, buildRows, toCsv, fetchAllTransactions, makeCallApi, parseArgs } = require('./audit-star-payments')

const ID = '64b7f0c2a1b2c3d4e5f60718'
const NOW = 2000000000000
const OLD = NOW / 1000 - 3600

const charge = (over = {}) => ({
  id: 'ch1',
  amount: 60,
  date: OLD,
  source: { type: 'user', user: { id: 111 }, invoice_payload: ID },
  ...over
})
const verdict = (payment, refunded = false, tx = charge()) => classify({ tx, payment, refunded, nowMs: NOW })

let failed = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(() => console.log(`  PASS  ${name}`), (error) => {
    failed++
    console.log(`  FAIL  ${name}\n        ${error.stack}`)
  })
}

;(async () => {
  console.log('audit star payments test')

  await test('a charge left on a pending payment is lost', () => {
    assert.strictEqual(verdict({ status: 'pending' }), 'lost')
  })

  await test('a very recent pending charge is not reported as lost', () => {
    assert.strictEqual(verdict({ status: 'pending' }, false, charge({ date: NOW / 1000 - 60 })), 'in_flight')
  })

  await test('a credited payment with this charge is fine', () => {
    assert.strictEqual(verdict({ status: 'paid', resultData: { telegram_payment_charge_id: 'ch1' } }), 'ok')
  })

  await test('a second charge on an already paid invoice is reported', () => {
    const paid = { status: 'paid', resultData: { telegram_payment_charge_id: 'other' } }
    assert.strictEqual(verdict(paid), 'second_charge')
    assert.strictEqual(verdict(paid, true), 'second_charge_refunded')
  })

  await test('a paid payment with no recorded charge is not called fine', () => {
    assert.strictEqual(verdict({ status: 'paid' }), 'paid_without_charge_id')
    assert.strictEqual(verdict({ status: 'paid', resultData: {} }, true), 'paid_and_refunded')
  })

  await test('a refunded lost charge needs no credit but stays visible', () => {
    assert.strictEqual(verdict({ status: 'pending' }, true), 'lost_but_refunded')
  })

  await test('a Telegram refund the bot does not know about is reported', () => {
    const paid = { status: 'paid', resultData: { telegram_payment_charge_id: 'ch1' } }
    assert.strictEqual(verdict(paid, true), 'paid_and_refunded')
    assert.strictEqual(verdict({ status: 'refunded', resultData: { telegram_payment_charge_id: 'ch1' } }, true), 'ok')
  })

  await test('other states, a missing record and foreign payloads are told apart', () => {
    assert.strictEqual(verdict({ status: 'credit_failed', resultData: { telegram_payment_charge_id: 'ch1' } }), 'status_credit_failed')
    assert.strictEqual(verdict(undefined), 'no_payment_record')
    assert.strictEqual(verdict(undefined, false, charge({ source: { type: 'user', invoice_payload: 'hello' } })), 'not_our_invoice')
    assert.strictEqual(verdict(undefined, false, charge({ source: { type: 'user' } })), 'not_our_invoice')
  })

  await test('a refund shares the id of its charge and does not replace it', () => {
    const { incoming, refundedIds } = splitTransactions([
      charge(),
      { id: 'ch1', amount: 60, date: OLD, receiver: { type: 'user', user: { id: 111 } } },
      { id: 'w1', amount: 500, date: OLD, receiver: { type: 'fragment' } }
    ])
    assert.strictEqual(incoming.size, 1)
    assert.deepStrictEqual([...refundedIds], ['ch1'])
  })

  await test('rows respect the window and show who the payment is recorded to', () => {
    const paymentsById = new Map([[ID, { status: 'pending', amount: 3, price: 60, user: 'u1' }]])
    const usersById = new Map([['u1', { telegram_id: 222 }]])
    const { incoming, refundedIds } = splitTransactions([charge(), charge({ id: 'old', date: OLD - 86400 * 2 })])
    const rows = buildRows({ incoming, refundedIds, paymentsById, usersById, cutoffMs: NOW - 86400 * 1000, nowMs: NOW })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].verdict, 'lost')
    assert.strictEqual(rows[0].payer_telegram_id, 111)
    assert.strictEqual(rows[0].recorded_user_telegram_id, 222)
  })

  await test('a payload in upper case still finds its payment', () => {
    const paymentsById = new Map([[ID, { status: 'pending' }]])
    const { incoming, refundedIds } = splitTransactions([charge({ source: { type: 'user', invoice_payload: ID.toUpperCase() } })])
    const rows = buildRows({ incoming, refundedIds, paymentsById, usersById: new Map(), cutoffMs: 0, nowMs: NOW })
    assert.strictEqual(rows[0].verdict, 'lost')
  })

  await test('CSV quotes separators and defuses spreadsheet formulas', () => {
    assert.strictEqual(toCsv([]), '')
    assert.strictEqual(toCsv([{ a: 'x,y', b: '=SUM(A1)' }]), 'a,b\n"x,y",\'=SUM(A1)\n')
  })

  await test('every page is read, since the API order is not relied on', async () => {
    const offsets = []
    const callApi = async (method, { offset, limit }) => {
      assert.strictEqual(method, 'getStarTransactions')
      offsets.push(offset)
      return { transactions: offset === 0 ? new Array(limit).fill(charge()) : [charge()] }
    }
    const all = await fetchAllTransactions(callApi)
    assert.deepStrictEqual(offsets, [0, 100])
    assert.strictEqual(all.length, 101)
  })

  await test('429 waits and retries; an API error never carries the token', async () => {
    const replies = [
      { ok: false, error_code: 429, parameters: { retry_after: 2 } },
      { ok: true, result: { transactions: [] } },
      { ok: false, error_code: 401, description: 'Unauthorized' }
    ]
    const waits = []
    const callApi = makeCallApi('SECRET', async () => ({ json: async () => replies.shift() }), async (ms) => { waits.push(ms) })
    assert.deepStrictEqual(await callApi('getStarTransactions', {}), { transactions: [] })
    assert.deepStrictEqual(waits, [3000])
    await assert.rejects(callApi('getStarTransactions', {}), (error) => !error.message.includes('SECRET') && error.message.includes('401'))
  })

  await test('arguments are checked', () => {
    assert.deepStrictEqual(parseArgs([]), { days: 90, out: null })
    assert.deepStrictEqual(parseArgs(['--days', '7', '--out', 'r.csv']), { days: 7, out: 'r.csv' })
    assert.throws(() => parseArgs(['--days', 'x']))
    assert.throws(() => parseArgs(['--write']))
  })

  if (failed) {
    console.log(`${failed} failed`)
    process.exit(1)
  }
  console.log('audit star payments test OK')
})()
