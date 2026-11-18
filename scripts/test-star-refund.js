// Unit tests for utils/star-refund.js. In-memory fakes for the Payment and
// User models, a pass-through transaction, and a scripted Telegram.

const assert = require('assert')
const { refundStarPayment } = require('../utils/star-refund')

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
    console.log(`        ${error.stack}`)
  }
}

const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => k === 'resultData.telegram_payment_charge_id' ? doc.resultData?.telegram_payment_charge_id === v : String(doc[k]) === String(v))
const apply = (doc, update) => {
  Object.assign(doc, update.$set || {})
  for (const k of Object.keys(update.$unset || {})) delete doc[k]
  for (const [k, v] of Object.entries(update.$inc || {})) doc[k] = (doc[k] || 0) + v
}

function world ({ status = 'paid', amount = 50, refundFrom, telegram = async () => true, failCommit = false } = {}) {
  const payment = { _id: 'p1', user: 'u1', amount, status, resultData: { telegram_payment_charge_id: 'ch' }, ...(refundFrom ? { refundFrom } : {}) }
  const user = { _id: 'u1', telegram_id: 7, balance: 100 }
  const calls = []
  const db = {
    Payment: {
      findOne: async (f) => (matches(payment, f) ? { ...payment } : null),
      findOneAndUpdate: async (f, u) => { if (!matches(payment, f)) return null; apply(payment, u); return { ...payment } },
      updateOne: async (f, u) => {
        if (failCommit && u.$set?.status === 'refunded') throw new Error('db down')
        if (!matches(payment, f)) return { matchedCount: 0 }
        apply(payment, u)
        return { matchedCount: 1 }
      }
    },
    User: {
      findOne: () => ({ select: () => ({ lean: async () => ({ ...user }) }) }),
      updateOne: async (f, u) => { apply(user, u); return { matchedCount: 1 } }
    },
    connection: { startSession: async () => ({ withTransaction: (fn) => fn(), endSession: async () => {} }) }
  }
  const tg = { callApi: async (method, params) => { calls.push([method, params]); return telegram() } }
  return { db, telegram: tg, payment, user, calls }
}
const tgError = (code, description) => Object.assign(new Error(description), { code, description })

;(async () => {
  await test('a paid payment: Stars back, payment refunded, credits taken off', async () => {
    const w = world()
    const r = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
    assert.strictEqual(r.outcome, 'done')
    assert.strictEqual(w.payment.status, 'refunded')
    assert.strictEqual(w.payment.refundFrom, undefined)
    assert.strictEqual(w.user.balance, 50)
    assert.deepStrictEqual(w.calls[0], ['refundStarPayment', { user_id: 7, telegram_payment_charge_id: 'ch' }])
  })

  for (const status of ['mismatch', 'credit_failed']) {
    await test(`a ${status} payment was never credited: refunded, balance untouched`, async () => {
      const w = world({ status })
      const r = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
      assert.strictEqual(r.outcome, 'done')
      assert.strictEqual(w.user.balance, 100)
    })
  }

  await test('Telegram refuses a first attempt: the payment is as it was', async () => {
    const w = world({ telegram: async () => { throw tgError(400, 'Bad Request: CHARGE_NOT_FOUND') } })
    const r = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
    assert.strictEqual(r.outcome, 'refused')
    assert.strictEqual(w.payment.status, 'paid')
    assert.strictEqual(w.user.balance, 100)
  })

  await test('no answer from Telegram: stays refunding, and a rerun finishes on CHARGE_ALREADY_REFUNDED', async () => {
    let first = true
    const w = world({ telegram: async () => { if (first) { first = false; throw tgError(502, 'Bad Gateway') } throw tgError(400, 'Bad Request: CHARGE_ALREADY_REFUNDED') } })
    const r1 = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
    assert.strictEqual(r1.outcome, 'uncertain')
    assert.strictEqual(w.payment.status, 'refunding')
    assert.strictEqual(w.payment.refundFrom, 'paid')
    assert.strictEqual(w.user.balance, 100)
    const r2 = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
    assert.strictEqual(r2.outcome, 'done')
    assert.strictEqual(w.payment.status, 'refunded')
    assert.strictEqual(w.user.balance, 50, 'debited once, from the original status')
  })

  await test('a refused resume stays refunding: an earlier attempt may have refunded', async () => {
    const w = world({ status: 'refunding', refundFrom: 'paid', telegram: async () => { throw tgError(400, 'Bad Request: SOMETHING_ELSE') } })
    const r = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
    assert.strictEqual(r.outcome, 'refused')
    assert.strictEqual(w.payment.status, 'refunding')
  })

  await test('the records fail after the refund: stays refunding with nothing debited, a rerun finishes', async () => {
    const w = world({ failCommit: true })
    const r1 = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
    assert.strictEqual(r1.outcome, 'not_recorded')
    assert.strictEqual(w.payment.status, 'refunding')
    assert.strictEqual(w.user.balance, 100)
  })

  await test('already refunded, pending, unknown: nothing is sent to Telegram', async () => {
    for (const [status, outcome] of [['refunded', 'already'], ['pending', 'not_refundable']]) {
      const w = world({ status })
      const r = await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'ch' })
      assert.strictEqual(r.outcome, outcome)
      assert.strictEqual(w.calls.length, 0)
    }
    const w = world()
    assert.strictEqual((await refundStarPayment({ db: w.db, telegram: w.telegram, chargeId: 'nope' })).outcome, 'not_found')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
  console.log('star-refund test OK')
})()
