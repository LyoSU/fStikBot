const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const { match } = require('telegraf-i18n')
const { WalletPaySDK } = require('wallet-pay-sdk')

const walletPay = new WalletPaySDK({
  apiKey: process.env.WALLETPAY_API_KEY,
  timeoutSeconds: 10800
})

const composer = new Composer()

const donateMenu = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('donate.menu', {
    titleSuffix: ` :: @${ctx.options.username}`,
    balance: ctx.session.userInfo.balance
  }), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.callbackButton(ctx.i18n.t('donate.btn.donate'), 'donate:topup')]
    ])
  })
}

composer.hears(['/donate', '/boost', '/start boost', match('cmd.start.btn.club')], donateMenu)

composer.action('donate:topup', async (ctx) => {
  return ctx.scene.enter('donate')
})

composer.action(/donate:(\d+)/, async (ctx) => {
  return ctx.scene.enter('donate', {
    amount: ctx.match[1]
  })
})

composer.start(async (ctx, next) => {
  if (ctx.startPayload === 'donate') {
    return donateMenu(ctx)
  }

  if (ctx.startPayload.startsWith('wp=')) {
    const payId = ctx.startPayload.split('=')[1]

    const payment = await ctx.db.Payment.findById(payId)

    if (!payment) {
      return ctx.replyWithHTML('Payment not found')
    }

    if (payment.status === 'pending') {
      const paymentInfo = await walletPay.getPreviewOrder(payment.paymentId)

      if (paymentInfo.data.status === 'PAID') {
        payment.status = 'paid'
        await payment.save()

        ctx.session.userInfo.balance += payment.amount
        await ctx.session.userInfo.save()

        return ctx.replyWithHTML(ctx.i18n.t('donate.update', {
          amount: payment.amount,
          balance: ctx.session.userInfo.balance
        }))
      }
    }

    if (payment.status === 'paid') {
      return ctx.replyWithHTML('Payment already paid')
    }
  }

  return next()
})

module.exports = composer
