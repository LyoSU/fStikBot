// Invoice links for credits bought in Studio. The API runs under another bot's
// token, and an invoice is paid to the bot that made it, so the API leaves a
// pending Payment with `invoice.state: 'requested'` (fstikbot-api
// routes/api/studio/credits.js) and this makes the link with our token:
//
//   requested → creating → ready (invoice.link) | failed | expired
//
// The payload is the Payment's _id, exactly as handlers/donate.js sends it, so
// pre_checkout_query and successful_payment there credit the payer as for any
// purchase in the chat. Nothing here touches a balance. The price is ours too:
// the bot's own regional table for the user's language, not the API's copy.

const path = require('path')
const I18n = require('telegraf-i18n')
const { calculateStarPrice, CREDIT_PACKAGES } = require('../scenes/donate')
const log = require('./logger').scope('studio-invoices')
const { logError } = require('./error-line')

const TICK_INTERVAL_MS = parseInt(process.env.STUDIO_INVOICE_TICK_MS, 10) || 1000
// Studio stops waiting for a link after this long (the API's INVOICE_WAIT_MS);
// a request older than that is not made into a link nobody would open.
const REQUEST_TTL_MS = 30 * 1000
// A `creating` claim older than this is a dead process's.
const CLAIM_STALE_MS = 15 * 1000

const errorText = (err) => err?.description || err?.response?.description || err?.message || String(err)

const defaultI18n = () => new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'en',
  defaultLanguageOnMissing: true
})

function mongoRepo (db) {
  return {
    claim: (now, staleBefore) => db.Payment.findOneAndUpdate(
      {
        status: 'pending',
        source: 'studio',
        $or: [
          { 'invoice.state': 'requested' },
          { 'invoice.state': 'creating', 'invoice.claimedAt': { $lt: staleBefore } }
        ]
      },
      { $set: { 'invoice.state': 'creating', 'invoice.claimedAt': now } },
      { sort: { createdAt: 1 }, new: true }
    ).lean(),
    findUser: (id) => db.User.findById(id).select('locale').lean(),
    // Only our own claim is settled: a request that timed out meanwhile and was
    // claimed again by another process is that process's.
    settle: (payment, set) => db.Payment.updateOne(
      { _id: payment._id, 'invoice.state': 'creating', 'invoice.claimedAt': payment.invoice.claimedAt },
      { $set: set }
    )
  }
}

/**
 * @param {Object} deps
 * @param {Object} deps.repo database access (mongoRepo)
 * @param {{callApi: Function}} deps.telegram
 * @param {Object} [deps.i18n] telegraf-i18n instance
 * @param {Function} [deps.now]
 */
function createInvoiceMaker ({ repo, telegram, i18n = defaultI18n(), now = () => new Date() }) {
  let timer = null
  let active = null
  let stopping = false

  async function make (payment) {
    const amount = payment.amount

    if (now().getTime() - new Date(payment.createdAt).getTime() > REQUEST_TTL_MS) {
      await repo.settle(payment, { 'invoice.state': 'expired' })
      return
    }
    if (!CREDIT_PACKAGES[amount]) {
      await repo.settle(payment, { 'invoice.state': 'failed', 'invoice.error': 'bad_amount' })
      return
    }

    const user = await repo.findUser(payment.user)
    if (!user) {
      await repo.settle(payment, { 'invoice.state': 'failed', 'invoice.error': 'user_not_found' })
      return
    }

    // As in the chat, where ctx.i18n.locale() is the user's saved language.
    const locale = user.locale || 'en'
    const price = calculateStarPrice(amount, locale)

    try {
      const link = await telegram.callApi('createInvoiceLink', {
        title: i18n.t(locale, 'donate.invoice_title', { amount }),
        description: i18n.t(locale, 'donate.description', { amount }),
        payload: payment._id.toString(),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Credits', amount: price }]
      })
      await repo.settle(payment, { price, 'invoice.state': 'ready', 'invoice.link': link })
      log.info(`payment ${payment._id}: invoice link for ${amount} credits (${price} XTR)`)
    } catch (err) {
      logError(err, { where: 'studio-invoices:invoice' })
      await repo.settle(payment, { 'invoice.state': 'failed', 'invoice.error': errorText(err).slice(0, 200) })
    }
  }

  // One request. Returns false when there was none.
  async function step () {
    const at = now()
    const payment = await repo.claim(at, new Date(at.getTime() - CLAIM_STALE_MS))
    if (!payment) return false
    await make(payment)
    return true
  }

  async function tick () {
    if (active || stopping) return
    active = (async () => {
      try {
        let worked
        do {
          worked = !stopping && await step()
        } while (worked)
      } catch (err) {
        logError(err, { where: 'studio-invoices:tick' })
      } finally {
        active = null
      }
    })()
    await active
  }

  function start () {
    if (timer) return
    timer = setInterval(() => { tick() }, TICK_INTERVAL_MS)
    timer.unref()
  }

  async function stop () {
    stopping = true
    if (timer) clearInterval(timer)
    timer = null
    if (active) await active.catch(() => {})
  }

  return { start, stop, tick, step }
}

let instance = null

function getInvoiceMaker () {
  if (!instance) {
    const { db } = require('../database')
    const telegram = require('./telegram')
    instance = createInvoiceMaker({ repo: mongoRepo(db), telegram })
  }
  return instance
}

module.exports = {
  REQUEST_TTL_MS,
  createInvoiceMaker,
  mongoRepo,
  start: () => getInvoiceMaker().start(),
  stop: () => (instance ? instance.stop() : Promise.resolve())
}
