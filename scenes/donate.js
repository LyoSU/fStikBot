const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { WalletPaySDK } = require('wallet-pay-sdk')
const mongoose = require('mongoose')

const donate = async (ctx) => {
  const amount = parseInt(ctx?.message?.text) || ( ctx?.match && parseInt(ctx?.match[1]))

  if (isNaN(amount)) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  if (amount < 5) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  if (amount > 1000) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  const price = amount / 5
  const starPrice = amount * 10

  const comment = `@${ctx?.from?.username || ctx?.from?.id} (${ctx.from.id}) for ${amount} Credits`

  const walletPayment = new ctx.db.Payment({
    _id: mongoose.Types.ObjectId(),
    user: ctx.session.userInfo._id,
    amount,
    price: price,
    currency: 'USD',
    paymentSystem: 'walletpay',
    comment,
    status: 'pending'
  })

  await walletPayment.save()

  const telegramPayment = new ctx.db.Payment({
    _id: mongoose.Types.ObjectId(),
    user: ctx.session.userInfo._id,
    amount,
    price: starPrice,
    currency: 'XTR',
    paymentSystem: 'telegram',
    comment,
    status: 'pending'
  })

  await telegramPayment.save()

  const replyMarkup =  Markup.inlineKeyboard([
    [Markup.payButton(`⭐️ Telegram Stars`)],
    // [Markup.callbackButton('👛 Crypto (TON, USDT, BTC)', `donate:walletpay:${walletPayment._id.toString()}`)]
  ])

  await ctx.replyWithInvoice({
    title: `Donate ${amount} Credits`,
    description: ctx.i18n.t('donate.description', {
      amount
    }),
    payload: telegramPayment._id.toString(),
    currency: 'XTR',
    prices: [{ label: 'Credits', amount: starPrice }],
    start_parameter: 'donate',
    reply_markup: replyMarkup
  })

  return ctx.scene.leave()
}

const donateScene = new Scene('donate')

donateScene.enter(async (ctx) => {
  if (ctx.scene.state.amount) {
    return donate(ctx)
  }

  await ctx.replyWithHTML(ctx.i18n.t('donate.menu', {
    titleSuffix: ` :: @${ctx.options.username}`,
    balance: ctx.session.userInfo.balance
  }), {
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.callbackButton('5 Credits', 'donate:5'),
        Markup.callbackButton('7 Credits', 'donate:7')
      ],
      [
        Markup.callbackButton('10 Credits', 'donate:10'),
        Markup.callbackButton('15 Credits', 'donate:15')
      ],
      [
        Markup.callbackButton('25 Credits', 'donate:25'),
        Markup.callbackButton('35 Credits', 'donate:35')
      ],
    ])
  })
})

donateScene.on('text', donate)

module.exports = donateScene
