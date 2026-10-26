// Unit tests for utils/payment-match.js: credits only for the Stars an
// invoice asked for, and for handlers/donate.js using it at checkout and on
// successful_payment.

const assert = require('assert')
const { paysFor } = require('../utils/payment-match')

let failed = 0
function test (name, fn) {
  return Promise.resolve().then(fn).then(() => console.log(`  PASS  ${name}`), (error) => {
    failed++
    console.log(`  FAIL  ${name}\n        ${error.stack}`)
  })
}

;(async () => {
  console.log('payment match test')

  await test('a Stars payment of the invoice\'s price pays for it; anything else does not', () => {
    const payment = { currency: 'XTR', price: 60 }
    assert.strictEqual(paysFor(payment, { currency: 'XTR', total_amount: 60 }), true)
    assert.strictEqual(paysFor(payment, { currency: 'XTR', total_amount: 59 }), false)
    assert.strictEqual(paysFor(payment, { currency: 'USD', total_amount: 60 }), false)
    assert.strictEqual(paysFor({ currency: 'XTR' }, { currency: 'XTR', total_amount: 60 }), false, 'no price on the payment')
    assert.strictEqual(paysFor({ currency: 'USD', price: 60 }, { currency: 'XTR', total_amount: 60 }), false)
    assert.strictEqual(paysFor(null, { currency: 'XTR', total_amount: 60 }), false)
  })

  await test('successful_payment credits a match once, and sets a mismatch aside uncredited', async () => {
    const { handlerOf, fakeCtx } = donateHarness()
    const onPaid = handlerOf('successful_payment')

    const good = fakeCtx({ price: 60 }, { currency: 'XTR', total_amount: 60 })
    await onPaid(good)
    assert.strictEqual(good.user.balance, 3)
    assert.strictEqual(good.payment.status, 'paid')
    await onPaid(good) // the update delivered twice
    assert.strictEqual(good.user.balance, 3)

    const bad = fakeCtx({ price: 60 }, { currency: 'XTR', total_amount: 1 })
    await onPaid(bad)
    assert.strictEqual(bad.user.balance, 0)
    assert.strictEqual(bad.payment.status, 'mismatch')
  })

  await test('a checkout that does not match its payment is refused', async () => {
    const { handlerOf, fakeCtx } = donateHarness()
    const onCheckout = handlerOf('pre_checkout_query')
    const answers = []
    const ctx = fakeCtx({ price: 60 }, null)
    ctx.preCheckoutQuery = { invoice_payload: 'p1', currency: 'XTR', total_amount: 1 }
    ctx.answerPreCheckoutQuery = async (ok) => answers.push(ok)
    await onCheckout(ctx)
    ctx.preCheckoutQuery.total_amount = 60
    await onCheckout(ctx)
    assert.deepStrictEqual(answers, [false, true])
  })

  if (failed) process.exit(1)
  console.log('payment match test OK')
})()

// handlers/donate.js on an in-memory Payment and User.
function donateHarness () {
  process.env.LOG_LEVEL = 'error'
  const donate = require('../handlers/donate')
  const handlerOf = (type) => (type === 'pre_checkout_query' ? donate.onPreCheckout : donate.onSuccessfulPayment)

  const matches = (doc, query) => Object.entries(query).every(([k, v]) => k === '_id' ? doc._id === v : doc[k] === v)
  const fakeCtx = (payment, paid) => {
    const doc = { _id: 'p1', amount: 3, currency: 'XTR', status: 'pending', ...payment }
    const user = { _id: 'u1', balance: 0 }
    const apply = (query, update) => {
      if (!matches(doc, query)) return null
      Object.assign(doc, update.$set)
      return doc
    }
    return {
      payment: doc,
      user,
      message: paid ? { successful_payment: { invoice_payload: 'p1', ...paid } } : {},
      session: { userInfo: { _id: 'u1' } },
      i18n: { t: (key) => key },
      replyWithHTML: async () => {},
      db: {
        Payment: {
          findOne: (query) => ({ catch: async () => (matches(doc, query) ? doc : null) }),
          updateOne: (query, update) => ({ catch: async () => apply(query, update) }),
          findOneAndUpdate: (query, update) => ({ catch: async () => apply(query, update) })
        },
        User: {
          findByIdAndUpdate: (id, update) => ({ catch: async () => { user.balance += update.$inc.balance; return user } })
        }
      }
    }
  }
  return { handlerOf, fakeCtx }
}
