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

  // Atomic pending → paid flip: a duplicated update can't credit twice.
  // `user` is set to the payer — an invoice can be forwarded, and refunds
  // (handlers/admin) go to payment.user, so it must be whoever actually paid.
  // The price is part of the match, so a Payment changed since the check above
  // isn't credited either.
  const updated = await ctx.db.Payment.findOneAndUpdate(
    { _id: successfulPayment.invoice_payload, status: 'pending', currency: 'XTR', price: successfulPayment.total_amount },
    { $set: { status: 'paid', user: ctx.session.userInfo._id, resultData: successfulPayment } },
    { new: true }
  ).catch(() => null)

  if (!updated) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.already_donated'))
  }

  // The Stars are already taken. A failed credit is marked on the payment so
  // it can be found (status: 'credit_failed') and credited by hand.
  const updatedUser = await ctx.db.User.findByIdAndUpdate(
    ctx.session.userInfo._id,
    { $inc: { balance: updated.amount } },
    { new: true, projection: { balance: 1 } }
  ).catch((error) => {
    log.error('credit failed for payment', updated._id.toString(), error)
    return null
  })

  if (!updatedUser) {
    log.error('payment paid but not credited:', updated._id.toString(), 'user:', ctx.session.userInfo._id)
    await ctx.db.Payment.updateOne({ _id: updated._id }, { $set: { status: 'credit_failed' } })
      .catch((error) => log.error('could not mark payment credit_failed:', updated._id.toString(), error))
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.error'))
  }

  syncBalance(ctx.session.userInfo, updatedUser.balance)

  return ctx.replyWithHTML(ctx.i18n.t('donate.update', {
    amount: updated.amount,
    balance: updatedUser.balance
  }))
}

composer.on('successful_payment', onSuccessfulPayment)

// "/start donate" and "/start boost" are routed in bot/commands.js.
composer.hears(['/donate', '/boost'], Composer.privateChat(donateMenu))

composer.action('donate:topup', donateMenu)

module.exports = composer
module.exports.onPreCheckout = onPreCheckout
module.exports.onSuccessfulPayment = onSuccessfulPayment
