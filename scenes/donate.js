const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const freekassa = require('@alex-kondakov/freekassa')
const CryptoPay = require('@foile/crypto-pay-api')
const { WalletPaySDK } = require('wallet-pay-sdk')
const mongoose = require('mongoose')

const cryptoPay = new CryptoPay.CryptoPay(process.env.CRYPTOPAY_API_KEY)

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
  const priceUAH = (price * exchangeRate.UAH).toFixed(2)
  const priceRUB = (price * exchangeRate.RUB).toFixed(2)

  const comment = `@${ctx.from.username} (${ctx.from.id}) for ${amount} Stars`

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

  const cryptoPayMe = await cryptoPay.getMe().catch(() => {})

  let tonLink, usdtLink, btcLink, ethLink
  let tonPrice, usdtPrice, btcPrice, ethPrice

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
    price: price,
    currency: 'XTR',
    paymentSystem: 'telegram',
    comment,
    status: 'pending'
  })

  await telegramPayment.save()

  if (cryptoPayMe) {
    const exchangeRate = await cryptoPay.getExchangeRates()

    const availableCurrencies = ['TON', 'USDT', 'BTC', 'ETH']

    for (const currency of availableCurrencies) {
      const priceCurrency = exchangeRate.find((rate) => rate.source === currency && rate.target === 'USD').rate

      const invoice = await cryptoPay.createInvoice(currency, price / priceCurrency, {
        description: comment,
        expires_in: 3600
      })

      switch (currency) {
        case 'TON':
          tonLink = invoice.pay_url
          tonPrice = (price / priceCurrency).toFixed(5)
          break
        case 'USDT':
          usdtLink = invoice.pay_url
          usdtPrice = (price / priceCurrency).toFixed(2)
          break
        case 'BTC':
          btcLink = invoice.pay_url
          btcPrice = (price / priceCurrency).toFixed(8)
          break
        case 'ETH':
          ethLink = invoice.pay_url
          ethPrice = (price / priceCurrency).toFixed(8)
          break
      }
    }
  }

  const starPrice = amount

  const payLink = await ctx.telegram.callApi('createInvoiceLink', {
    title: `Donate ${amount} Stars`,
    description: comment,
    payload: telegramPayment._id.toString(),
    start_parameter: 'donate',
    currency: 'XTR',
    prices: [{ label: 'Stars', amount: starPrice }]
  }).catch(() => {})

  const repltMarkup =  Markup.inlineKeyboard([
    [Markup.urlButton(`🌟 Telegram Stars — ${starPrice}`, payLink, !payLink)],
    [Markup.urlButton(`Оплата — ${priceRUB}₽`, ruLink, !ruLink)],
    [Markup.urlButton(`💳 Card, Google Pay, Apple Pay — ${price}$ / ${priceUAH}₴`, `https://send.monobank.ua/jar/6RwLN9a9Yj?a=${priceUAH}&t=${encodeURI(comment)}`, !(ctx.session.userInfo.locale === 'uk' || ctx.from.language_code === 'uk'))],
    [Markup.callbackButton('👛 Crypto (TON, USDT, BTC)', `donate:walletpay:${walletPayment._id.toString()}`)],
    [
      Markup.urlButton(`${tonPrice} TON`, tonLink, !tonLink),
      Markup.urlButton(`${usdtPrice} USDT`, usdtLink, !usdtLink)
    ],
    [
      Markup.urlButton(`${btcPrice} BTC`, btcLink, !btcLink),
      Markup.urlButton(`${ethPrice} ETH`, ethLink, !ethLink)
    ]
  ])

  await ctx.replyWithHTML(message, {
    reply_markup: repltMarkup
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
