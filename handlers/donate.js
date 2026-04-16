const Composer = require('telegraf/composer')
const { match } = require('telegraf-i18n')

const composer = new Composer()

const donateMenu = async (ctx) => {
  return ctx.scene.enter('donate')
}

composer.on('pre_checkout_query', async (ctx) => {
  const telegramPayment = await ctx.db.Payment.findOne({
    _id: ctx.preCheckoutQuery.invoice_payload
  })

  if (!telegramPayment || telegramPayment.status !== 'pending') {
    return ctx.answerPreCheckoutQuery(false, ctx.i18n.t('donate.error.already_donated'))
  }

  await ctx.answerPreCheckoutQuery(true)
})

composer.on('successful_payment', async (ctx) => {
  const telegramPayment = await ctx.db.Payment.findOne({
    _id: ctx.message.successful_payment.invoice_payload
  })

  if (!telegramPayment || telegramPayment.status !== 'pending') {
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.already_donated'))
  }

  const updated = await ctx.db.Payment.findOneAndUpdate(
    { _id: telegramPayment._id, status: 'pending' },
    { $set: { status: 'paid', resultData: ctx.message.successful_payment } },
    { new: true }
  )
  if (!updated) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.already_donated'))
  }

  // Use atomic $inc to prevent race conditions
  const updatedUser = await ctx.db.User.findByIdAndUpdate(
    ctx.session.userInfo._id,
    { $inc: { balance: updated.amount } },
    { new: true }
  )

  if (!updatedUser) {
    console.error('User not found after payment:', ctx.session.userInfo._id)
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.user_not_found'))
  }

  ctx.session.userInfo.balance = updatedUser.balance

  return ctx.replyWithHTML(ctx.i18n.t('donate.update', {
    amount: updated.amount,
    balance: updatedUser.balance
  }))
})

composer.hears(['/donate', '/boost', '/start boost', match('cmd.start.btn.club')], Composer.privateChat(donateMenu))

composer.action('donate:topup', async (ctx) => {
  return ctx.scene.enter('donate')
})

composer.start(async (ctx, next) => {
  if (ctx.startPayload === 'donate') {
    return donateMenu(ctx)
  }

  return next()
})

module.exports = composer
