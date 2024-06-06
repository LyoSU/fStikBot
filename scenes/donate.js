const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const freekassa = require('@alex-kondakov/freekassa')
const { WalletPaySDK } = require('wallet-pay-sdk')
const mongoose = require('mongoose')

const walletPay = new WalletPaySDK({
  apiKey: process.env.WALLETPAY_API_KEY,
  timeoutSeconds: 10800
})

const exchangeRate = {
  RUB: 90,
  USD: 1,
  UAH: 35
}

const donate = async (ctx) => {
  const amount = parseInt(ctx?.message?.text) || ( ctx?.match && parseInt(ctx?.match[1]))

  if (isNaN(amount)) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  if (amount < 5) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  const price = amount / 5
  const starPrice = amount * 5
  const priceUAH = (price * exchangeRate.UAH).toFixed(2)
  const priceRUB = (price * exchangeRate.RUB).toFixed(2)

  const comment = `@${ctx?.from?.username || ctx?.from?.id} (${ctx.from.id}) for ${amount} Stars`

  let ruLink

  // if locale is ru
  if (ctx.session.userInfo.locale === 'ru' || ctx.from.language_code === 'ru') {
    const payment = new ctx.db.Payment({
      _id: mongoose.Types.ObjectId(),
      user: ctx.session.userInfo._id,
      amount,
      price: priceRUB,
      currency: 'RUB',
      paymentSystem: 'freekassa',
      comment,
      status: 'pending'
    })

    await payment.save()

    const freekassaPayment = freekassa.init()

    freekassaPayment.secret1 = process.env.FREEKASSA_SECRET1
    freekassaPayment.secret2 = process.env.FREEKASSA_SECRET2
    freekassaPayment.shopId = process.env.FREEKASSA_SHOP_ID
    freekassaPayment.paymentId = payment._id
    freekassaPayment.amount = priceRUB
    freekassaPayment.currency = 'RUB'
    freekassaPayment.description = comment

    freekassaPayment.sign()

    ruLink = await freekassaPayment.create()
  }

  const message = ctx.i18n.t('donate.paymenu', {
    amount,
    price
  })

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
    [Markup.urlButton(`💳 Оплата — ${priceRUB}₽`, ruLink, !ruLink)],
    // [Markup.urlButton(`💳 monobank — ${price}$ / ${priceUAH}₴`, `https://send.monobank.ua/jar/6RwLN9a9Yj?a=${priceUAH}&t=${encodeURI(comment)}`, !(ctx.i18n.locale() === 'uk'))],
    [Markup.callbackButton('👛 Crypto (TON, USDT, BTC)', `donate:walletpay:${walletPayment._id.toString()}`)]
  ])

  await ctx.replyWithInvoice({
    title: `Donate ${amount} Stars`,
    description: ctx.i18n.t('donate.description', {
      amount
    }),
    payload: telegramPayment._id.toString(),
    currency: 'XTR',
    prices: [{ label: 'Stars', amount: starPrice }],
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

  await ctx.editMessageText(ctx.i18n.t('donate.topup'), {
    parse_mode: 'HTML',
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.callbackButton('10 Stars', 'donate:10'),
        Markup.callbackButton('20 Stars', 'donate:20')
      ],
      [
        Markup.callbackButton('50 Stars', 'donate:50'),
        Markup.callbackButton('100 Stars', 'donate:100')
      ]
    ])
  })
})

donateScene.on('text', donate)

module.exports = donateScene
