const Composer = require('telegraf/composer')
const { calculateStarPrice, CREDIT_PACKAGES } = require('../scenes/donate')
const log = require('../utils/logger').scope('donate')
const { syncBalance } = require('../utils/session-balance')
const { paysFor } = require('../utils/payment-match')

const composer = new Composer()

const donateMenu = (ctx) => ctx.scene.enter('donate')

// Invoice payloads are Payment _ids; a malformed one must not throw a CastError.
const findPendingPayment = (ctx, id) => ctx.db.Payment.findOne({ _id: id, status: 'pending' }).catch(() => null)

// One pending Payment per tap on a package — i.e. per real purchase intent.
composer.action(/^donate:buy:(\d+)$/, async (ctx) => {
  const amount = parseInt(ctx.match[1], 10)
  if (!CREDIT_PACKAGES[amount]) return

  const price = calculateStarPrice(amount, ctx.i18n.locale())

  const payment = await ctx.db.Payment.create({
    user: ctx.session.userInfo._id,
    amount,
    price,
    currency: 'XTR',
    paymentSystem: 'telegram',
    status: 'pending'
  })

  await ctx.telegram.sendInvoice(ctx.chat.id, {
    title: ctx.i18n.t('donate.invoice_title', { amount }),
    description: ctx.i18n.t('donate.description', { amount }),
    payload: payment._id.toString(),
    provider_token: '',
    currency: 'XTR',
    prices: [{ label: 'Credits', amount: price }]
  })
})

async function onPreCheckout (ctx) {
  const payment = await findPendingPayment(ctx, ctx.preCheckoutQuery.invoice_payload)

  if (!payment) {
    return ctx.answerPreCheckoutQuery(false, ctx.i18n.t('donate.error.already_donated'))
  }

  if (!paysFor(payment, ctx.preCheckoutQuery)) {
    log.error('checkout does not match its payment:', payment._id.toString(), ctx.preCheckoutQuery.currency, ctx.preCheckoutQuery.total_amount)
    return ctx.answerPreCheckoutQuery(false, ctx.i18n.t('donate.error.error'))
  }

  await ctx.answerPreCheckoutQuery(true)
}

composer.on('pre_checkout_query', onPreCheckout)

const PAYMENT_NOT_RECORDED = Symbol('payment not recorded')

// The pending → paid flip and the credit commit together: a process dying
// between them can't leave a paid payment with nothing on the balance, and a
// death before the commit leaves it pending, where an audit finds it. The flip
// matches only `pending`, so a duplicated update can't credit twice; the price
// is part of the match, so a Payment changed since the check isn't credited.
// Returns null when no pending payment matched. withTransaction reruns the
// callback on a transient error, so its result starts empty on every attempt.
async function flipAndCredit (ctx, successfulPayment) {
  const session = await ctx.db.connection.startSession()
  try {
    let credited = null
    await session.withTransaction(async () => {
      credited = null
      const payment = await ctx.db.Payment.findOneAndUpdate(
        { _id: successfulPayment.invoice_payload, status: 'pending', currency: 'XTR', price: successfulPayment.total_amount },
        { $set: { status: 'paid', user: ctx.session.userInfo._id, resultData: successfulPayment } },
        { new: true, session }
      )
      if (!payment) return
      const user = await ctx.db.User.findByIdAndUpdate(
        ctx.session.userInfo._id,
        { $inc: { balance: payment.amount } },
        { new: true, projection: { balance: 1 }, session }
      )
      if (!user) throw new Error('payer not found')
      credited = { payment, user }
    })
    return credited
  } finally {
    await session.endSession()
  }
}

// Mounted before the scenes in bot/commands.js, not on this composer.
async function onSuccessfulPayment (ctx) {
  const { successful_payment: successfulPayment } = ctx.message

  // Credits only for Stars, and exactly the invoice's price: anything else is
  // set aside as `mismatch` for a look by hand, credited with nothing.
  const pending = await findPendingPayment(ctx, successfulPayment.invoice_payload)
  if (pending && !paysFor(pending, successfulPayment)) {
    log.error('payment does not match its invoice:', pending._id.toString(), successfulPayment.currency, successfulPayment.total_amount)
    await ctx.db.Payment.updateOne(
      { _id: pending._id, status: 'pending' },
      { $set: { status: 'mismatch', user: ctx.session.userInfo._id, resultData: successfulPayment } }
    ).catch((error) => log.error('could not mark payment mismatch:', pending._id.toString(), error))
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.error'))
  }

  // `user` is set to the payer — an invoice can be forwarded, and refunds
  // (handlers/admin) go to payment.user, so it must be whoever actually paid.
  const credited = await flipAndCredit(ctx, successfulPayment).catch((error) => {
    // A malformed payload isn't one of our invoices.
    if (error.name === 'CastError') return null
    log.error('payment may not be credited, check the audit before crediting by hand:', successfulPayment.invoice_payload, 'charge:', successfulPayment.telegram_payment_charge_id, 'user:', ctx.session.userInfo._id, error)
    return PAYMENT_NOT_RECORDED
  })

  if (credited === PAYMENT_NOT_RECORDED) {
    // The transaction rolled back, so the Stars are taken and nothing is
    // credited. Marked so it can be found and credited by hand; if the commit
    // did land after all, the status is no longer pending and this matches nothing.
    await ctx.db.Payment.updateOne(
      { _id: successfulPayment.invoice_payload, status: 'pending' },
      { $set: { status: 'credit_failed', user: ctx.session.userInfo._id, resultData: successfulPayment } }
    ).catch((error) => log.error('could not mark payment credit_failed:', successfulPayment.invoice_payload, error))
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.error'))
  }

  if (!credited) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.already_donated'))
  }

  const { payment: updated, user: updatedUser } = credited

  syncBalance(ctx.session.userInfo, updatedUser.balance)

  return ctx.replyWithHTML(ctx.i18n.t('donate.update', {
    amount: updated.amount,
    balance: updatedUser.balance
  }))
}

// "/start donate" and "/start boost" are routed in bot/commands.js.
composer.hears(['/donate', '/boost'], Composer.privateChat(donateMenu))

composer.action('donate:topup', donateMenu)

module.exports = composer
module.exports.onPreCheckout = onPreCheckout
module.exports.onSuccessfulPayment = onSuccessfulPayment
