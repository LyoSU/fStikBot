// Unit tests for utils/studio-invoices.js against an in-memory repo and a fake
// Telegram: the link is made with handlers/donate.js's payload and the bot's
// own regional price, old or broken requests end in a state Studio can show,
// and a dead process's claim is taken over.

process.env.LOG_LEVEL = 'error'
const assert = require('assert')
const { createInvoiceMaker, REQUEST_TTL_MS } = require('../utils/studio-invoices')
const { calculateStarPrice } = require('../scenes/donate')

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

const NOW = new Date('2026-10-26T12:00:00Z')
const ago = (ms) => new Date(NOW.getTime() - ms)

function world ({ payments = [], users = [{ _id: 'u1', locale: 'uk' }], fail = null } = {}) {
  const w = {
    payments: payments.map((p) => ({ status: 'pending', source: 'studio', createdAt: ago(1000), ...structuredClone(p) })),
    users: new Map(users.map((u) => [u._id, u])),
    calls: []
  }

  w.repo = {
    async claim (now, staleBefore) {
      const p = w.payments.find((x) => x.status === 'pending' && x.source === 'studio' && (
        x.invoice?.state === 'requested' ||
        (x.invoice?.state === 'creating' && x.invoice.claimedAt < staleBefore)))
      if (!p) return null
      p.invoice = { ...p.invoice, state: 'creating', claimedAt: now }
      return structuredClone(p)
    },
    async findUser (id) { return w.users.get(id) || null },
    async settle (payment, set) {
      const p = w.payments.find((x) => x._id === payment._id)
      if (p.invoice.state !== 'creating' || p.invoice.claimedAt.getTime() !== payment.invoice.claimedAt.getTime()) return
      for (const [key, value] of Object.entries(set)) {
        if (key.startsWith('invoice.')) p.invoice[key.slice(8)] = value
        else p[key] = value
      }
    }
  }

  w.telegram = {
    async callApi (method, payload) {
      w.calls.push({ method, payload })
      if (fail) throw fail
      return `https://t.me/$invoice-${payload.payload}`
    }
  }

  w.maker = createInvoiceMaker({ repo: w.repo, telegram: w.telegram, now: () => NOW })
  return w
}

const requested = (patch = {}) => ({ _id: 'p1', user: 'u1', amount: 3, invoice: { state: 'requested' }, ...patch })

;(async () => {
  console.log('studio-invoices')

  await test('makes a link with the Payment id as payload and the bot price', async () => {
    const w = world({ payments: [requested()] })
    await w.maker.tick()

    assert.strictEqual(w.calls.length, 1)
    const { method, payload } = w.calls[0]
    assert.strictEqual(method, 'createInvoiceLink')
    assert.strictEqual(payload.payload, 'p1')
    assert.strictEqual(payload.currency, 'XTR')
    assert.strictEqual(payload.provider_token, '')
    assert.deepStrictEqual(payload.prices, [{ label: 'Credits', amount: calculateStarPrice(3, 'uk') }])
    assert.strictEqual(payload.title, '3 кредитів')

    const p = w.payments[0]
    assert.strictEqual(p.invoice.state, 'ready')
    assert.strictEqual(p.invoice.link, 'https://t.me/$invoice-p1')
    assert.strictEqual(p.price, 36)
    // Paying is handlers/donate.js's business: the payment stays pending.
    assert.strictEqual(p.status, 'pending')
  })

  await test('prices by the user language, English without one', async () => {
    const w = world({
      payments: [requested({ _id: 'a', amount: 25 }), requested({ _id: 'b', user: 'u2', amount: 25 })],
      users: [{ _id: 'u1', locale: 'de' }, { _id: 'u2' }]
    })
    await w.maker.tick()

    assert.deepStrictEqual(w.calls.map((c) => c.payload.prices[0].amount), [Math.round(375 * 1.3), Math.round(375 * 1.3)])
    assert.strictEqual(w.calls[1].payload.title, '25 Credits')
  })

  await test('a request older than Studio waits is expired, not made', async () => {
    const w = world({ payments: [requested({ createdAt: ago(REQUEST_TTL_MS + 1) })] })
    await w.maker.tick()

    assert.strictEqual(w.calls.length, 0)
    assert.strictEqual(w.payments[0].invoice.state, 'expired')
  })

  await test('an amount that is not a package fails', async () => {
    const w = world({ payments: [requested({ amount: 7 })] })
    await w.maker.tick()

    assert.strictEqual(w.calls.length, 0)
    assert.strictEqual(w.payments[0].invoice.state, 'failed')
    assert.strictEqual(w.payments[0].invoice.error, 'bad_amount')
  })

  await test('a missing user fails', async () => {
    const w = world({ payments: [requested({ user: 'nobody' })] })
    await w.maker.tick()

    assert.strictEqual(w.payments[0].invoice.state, 'failed')
    assert.strictEqual(w.payments[0].invoice.error, 'user_not_found')
  })

  await test('a Telegram refusal fails with its description', async () => {
    const w = world({ payments: [requested()], fail: Object.assign(new Error('x'), { code: 400, description: 'Bad Request: CURRENCY_INVALID' }) })
    await w.maker.tick()

    assert.strictEqual(w.payments[0].invoice.state, 'failed')
    assert.strictEqual(w.payments[0].invoice.error, 'Bad Request: CURRENCY_INVALID')
    assert.strictEqual(w.payments[0].invoice.link, undefined)
  })

  await test('payments from the chat and paid ones are left alone', async () => {
    const w = world({
      payments: [
        { _id: 'chat', user: 'u1', amount: 3, source: undefined },
        requested({ _id: 'paid', status: 'paid' })
      ]
    })
    await w.maker.tick()

    assert.strictEqual(w.calls.length, 0)
    assert.strictEqual(w.payments[1].invoice.state, 'requested')
  })

  await test('a dead process claim is taken over, a fresh one is not', async () => {
    const w = world({
      payments: [
        requested({ _id: 'fresh', invoice: { state: 'creating', claimedAt: ago(1000) } }),
        requested({ _id: 'stale', invoice: { state: 'creating', claimedAt: ago(60 * 1000) } })
      ]
    })
    await w.maker.tick()

    assert.deepStrictEqual(w.calls.map((c) => c.payload.payload), ['stale'])
    assert.strictEqual(w.payments[0].invoice.state, 'creating')
    assert.strictEqual(w.payments[1].invoice.state, 'ready')
  })

  await test('works through every waiting request in one tick', async () => {
    const w = world({ payments: [requested({ _id: 'a' }), requested({ _id: 'b', amount: 1 })] })
    await w.maker.tick()

    assert.deepStrictEqual(w.payments.map((p) => p.invoice.state), ['ready', 'ready'])
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed) process.exit(1)
})()
