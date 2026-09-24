const Composer = require('telegraf/composer')
const { calculateStarPrice, CREDIT_PACKAGES } = require('../scenes/donate')
const log = require('../utils/logger').scope('donate')
const { syncBalance } = require('../utils/session-balance')

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

composer.on('pre_checkout_query', async (ctx) => {
  const payment = await findPendingPayment(ctx, ctx.preCheckoutQuery.invoice_payload)

  if (!payment) {
    return ctx.answerPreCheckoutQuery(false, ctx.i18n.t('donate.error.already_donated'))
  }

  await ctx.answerPreCheckoutQuery(true)
})

composer.on('successful_payment', async (ctx) => {
  const { successful_payment: successfulPayment } = ctx.message

  // Atomic pending → paid flip: a duplicated update can't credit twice.
  // `user` is set to the payer — an invoice can be forwarded, and refunds
  // (handlers/admin) go to payment.user, so it must be whoever actually paid.
  const updated = await ctx.db.Payment.findOneAndUpdate(
    { _id: successfulPayment.invoice_payload, status: 'pending' },
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
})

// "/start donate" and "/start boost" are routed in bot/commands.js.
composer.hears(['/donate', '/boost'], Composer.privateChat(donateMenu))

composer.action('donate:topup', donateMenu)

module.exports = composer
