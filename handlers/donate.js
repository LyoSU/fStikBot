const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')
const { match } = require('telegraf-i18n')
const { WalletPaySDK } = require('wallet-pay-sdk')
const CryptoPay = require('@foile/crypto-pay-api')

const cryptoPay = new CryptoPay.CryptoPay(process.env.CRYPTOPAY_API_KEY)

const walletPay = new WalletPaySDK({
  apiKey: process.env.WALLETPAY_API_KEY,
  timeoutSeconds: 10800
})

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

  telegramPayment.status = 'paid'
  telegramPayment.resultData = ctx.message.successful_payment
  await telegramPayment.save()

  ctx.session.userInfo.balance += telegramPayment.amount
  await ctx.session.userInfo.save()

  return ctx.replyWithHTML(ctx.i18n.t('donate.update', {
    amount: telegramPayment.amount,
    balance: ctx.session.userInfo.balance
  }))
})

composer.hears(['/donate', '/boost', '/start boost', match('cmd.start.btn.club')], donateMenu)

composer.action('donate:topup', async (ctx) => {
  return ctx.scene.enter('donate')
})

composer.action(/donate:walletpay:(.*)/, async (ctx) => {
  const payment = await ctx.db.Payment.findOne({
    _id: ctx.match[1]
  })

  if (!payment) {
    return ctx.replyWithHTML('Payment not found')
  }

  let walletPayLink

  const { amount, price } = payment

  const walletPayOrder = await walletPay.createOrder({
    amount: {
      currencyCode: "USD",
      amount: price
    },
    description: `Payment for ${amount} credits`,
    returnUrl: `https://t.me/${ctx.botInfo.username}?start=wp=${payment._id.toString()}`,
    failReturnUrl: `https://t.me/${ctx.botInfo.username}?start=wp=${payment._id.toString()}`,
    customData: JSON.stringify({
      paymentId: payment._id.toString(),
    }),
    externalId: payment._id.toString(),
    customerTelegramUserId: ctx.from.id,
  }).catch(() => {})

  if (walletPayOrder?.status === 'SUCCESS') {
    walletPayLink = walletPayOrder.data.payLink

    payment.paymentId = walletPayOrder.data.id

    await payment.save()
  }

  if (!walletPayLink) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.error.error'))
  }

  const comment = `@${ctx.from.username} (${ctx.from.id}) for ${amount} Credits`

  let tonLink, usdtLink, btcLink, ethLink
  let tonPrice, usdtPrice, btcPrice, ethPrice

  const cryptoPayMe = await cryptoPay.getMe().catch(() => {})

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


  return ctx.replyWithHTML(ctx.i18n.t('donate.paymenu', {
    amount,
    price
  }), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.urlButton('👛 Pay via Wallet', walletPayLink, !walletPayLink)],
      [
        Markup.urlButton(`${tonPrice} TON`, tonLink, !tonLink),
        Markup.urlButton(`${usdtPrice} USDT`, usdtLink, !usdtLink)
      ],
      [
        Markup.urlButton(`${btcPrice} BTC`, btcLink, !btcLink),
        Markup.urlButton(`${ethPrice} ETH`, ethLink, !ethLink)
      ]
    ])
  })
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
