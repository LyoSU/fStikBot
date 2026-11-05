// The flip and the credit against a real replica set, including a process killed
// between them. Skipped without one, since npm test runs without a database:
//   TEST_REPLSET_URI=mongodb://localhost:27017/paytest?directConnection=true node scripts/test-payment-transaction.js

process.env.LOG_LEVEL = 'silent'
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '0:test' // a dummy: this test must never reach Telegram
const URI = process.env.TEST_REPLSET_URI
if (!URI) {
  console.log('payment transaction test SKIPPED: set TEST_REPLSET_URI')
  process.exit(0)
}
process.env.MONGODB_URI = URI

const assert = require('assert')
const { spawnSync } = require('child_process')
const mongoose = require('mongoose')
const collections = require('../database/models')
const { onSuccessfulPayment } = require('../handlers/donate')

const connection = mongoose.createConnection(URI, { autoIndex: false })
const db = {
  connection,
  Payment: connection.model('Payment', collections.Payment),
  User: connection.model('User', collections.User)
}

function context (user, payment, chargeId, dbOverride = db) {
  const replies = []
  return {
    replies,
    db: dbOverride,
    session: { userInfo: { _id: user._id } },
    message: {
      successful_payment: {
        invoice_payload: String(payment._id),
        currency: 'XTR',
        total_amount: payment.price,
        telegram_payment_charge_id: chargeId
      }
    },
    i18n: { t: (key) => key },
    replyWithHTML: async (text) => { replies.push(text) }
  }
}

let seq = 0
async function seed (amount = 3) {
  seq++
  const user = await db.User.create({ telegram_id: Date.now() + seq, balance: 0 })
  const payment = await db.Payment.create({ user: user._id, amount, price: 60, currency: 'XTR', paymentSystem: 'telegram', status: 'pending' })
  return { user, payment }
}
const balanceOf = async (user) => (await db.User.findById(user._id).lean()).balance
const statusOf = async (payment) => (await db.Payment.findById(payment._id).lean()).status

// Child: dies by SIGKILL with the flip written and the credit not yet.
if (process.argv[2] === 'die-mid-transaction') {
  ;(async () => {
    await connection.asPromise()
    const user = await db.User.findById(process.argv[3])
    const payment = await db.Payment.findById(process.argv[4])
    const dying = { ...db, User: { findByIdAndUpdate: () => process.kill(process.pid, 'SIGKILL') } }
    await onSuccessfulPayment(context(user, payment, 'ch-killed', dying))
  })()
  return
}

let failed = 0
async function test (name, fn) {
  try {
    await fn()
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}\n        ${error.stack}`)
  }
}

;(async () => {
  console.log('payment transaction test')
  await connection.asPromise()
  await db.Payment.createCollection()
  await db.User.createCollection()

  await test('a payment flips and credits together', async () => {
    const { user, payment } = await seed()
    const ctx = context(user, payment, 'ch1')
    await onSuccessfulPayment(ctx)
    assert.strictEqual(await statusOf(payment), 'paid')
    assert.strictEqual(await balanceOf(user), 3)
    assert.deepStrictEqual(ctx.replies, ['donate.update'])
  })

  await test('a repeated update does not credit twice', async () => {
    const { user, payment } = await seed()
    await onSuccessfulPayment(context(user, payment, 'ch2'))
    const again = context(user, payment, 'ch2')
    await onSuccessfulPayment(again)
    assert.strictEqual(await balanceOf(user), 3)
    assert.deepStrictEqual(again.replies, ['donate.error.already_donated'])
  })

  await test('the same update twice at once credits once', async () => {
    const { user, payment } = await seed()
    await Promise.all([onSuccessfulPayment(context(user, payment, 'ch3')), onSuccessfulPayment(context(user, payment, 'ch3'))])
    assert.strictEqual(await balanceOf(user), 3)
  })

  await test('payments of one user at once all credit, retrying write conflicts', async () => {
    const { user, payment } = await seed(1)
    const others = await Promise.all(Array.from({ length: 7 }, () =>
      db.Payment.create({ user: user._id, amount: 1, price: 60, currency: 'XTR', paymentSystem: 'telegram', status: 'pending' })))
    await Promise.all([payment, ...others].map((p, i) => onSuccessfulPayment(context(user, p, `ch4-${i}`))))
    assert.strictEqual(await balanceOf(user), 8)
  })

  await test('a credit that fails rolls the flip back and is marked', async () => {
    const { user, payment } = await seed()
    await db.User.deleteOne({ _id: user._id })
    const ctx = context(user, payment, 'ch5')
    await onSuccessfulPayment(ctx)
    const after = await db.Payment.findById(payment._id).lean()
    assert.strictEqual(after.status, 'credit_failed')
    assert.strictEqual(after.resultData.telegram_payment_charge_id, 'ch5')
    assert.deepStrictEqual(ctx.replies, ['donate.error.error'])
  })

  await test('a malformed payload is not treated as a failed credit', async () => {
    const { user } = await seed()
    const ctx = context(user, { _id: 'not-an-id', price: 60 }, 'ch6')
    await onSuccessfulPayment(ctx)
    assert.deepStrictEqual(ctx.replies, ['donate.error.already_donated'])
  })

  await test('a process killed between flip and credit leaves it pending, nothing half done', async () => {
    const { user, payment } = await seed()
    const child = spawnSync(process.execPath, [__filename, 'die-mid-transaction', String(user._id), String(payment._id)], { env: process.env, timeout: 30000 })
    assert.strictEqual(child.signal, 'SIGKILL')
    assert.strictEqual(await statusOf(payment), 'pending')
    assert.strictEqual(await balanceOf(user), 0)
    // The abandoned transaction must not block the retry forever.
    const ctx = context(user, payment, 'ch7')
    await onSuccessfulPayment(ctx)
    assert.strictEqual(await statusOf(payment), 'paid')
    assert.strictEqual(await balanceOf(user), 3)
  })

  await connection.close()
  if (failed) {
    console.log(`${failed} failed`)
    process.exit(1)
  }
  console.log('payment transaction test OK')
  process.exit(0)
})()
