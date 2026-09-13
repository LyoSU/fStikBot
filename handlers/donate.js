const Composer = require('telegraf/composer')
const { calculateStarPrice, CREDIT_PACKAGES } = require('../scenes/donate')
const log = require('../utils/logger').scope('donate')

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

  const updatedUser = await ctx.db.User.findByIdAndUpdate(
    ctx.session.userInfo._id,
    { $inc: { balance: updated.amount } },
    { new: true }
  )

  if (!updatedUser) {
    log.error('user not found after payment:', ctx.session.userInfo._id)
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.user_not_found'))
  }

  ctx.session.userInfo.balance = updatedUser.balance

  return ctx.replyWithHTML(ctx.i18n.t('donate.update', {
    amount: updated.amount,
    balance: updatedUser.balance
  }))
})

composer.hears(['/donate', '/boost', '/start boost'], Composer.privateChat(donateMenu))

composer.action('donate:topup', donateMenu)

composer.start((ctx, next) => {
  if (ctx.startPayload === 'donate') return donateMenu(ctx)
  return next()
})

module.exports = composer
