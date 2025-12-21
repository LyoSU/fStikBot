const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { WalletPaySDK } = require('wallet-pay-sdk')
const mongoose = require('mongoose')

// Regional pricing tiers
const PRICING_TIERS = {
  // Tier 1 - Premium regions (×1.3)
  tier1: ['en', 'de', 'fr', 'ja'],
  // Tier 2 - Standard regions (×1.0)
  tier2: ['es', 'pt', 'tr', 'ar', 'zh'],
  // Tier 3 - Economy regions (×0.6)
  tier3: ['ru', 'uk', 'uz', 'kk', 'id', 'be', 'hy', 'az']
}

const TIER_MULTIPLIERS = {
  tier1: 1.3,
  tier2: 1.0,
  tier3: 0.6
}

// Base star prices with volume discounts
const CREDIT_PACKAGES = {
  1: { stars: 25, discount: 0 },       // $0.33 base
  3: { stars: 60, discount: 0.20 },    // $0.78 (20% off)
  5: { stars: 100, discount: 0.20 },   // $1.30 (20% off)
  10: { stars: 175, discount: 0.30 },  // $2.28 (30% off)
  25: { stars: 375, discount: 0.40 }   // $4.88 (40% off)
}

const getPricingTier = (locale) => {
  if (PRICING_TIERS.tier1.includes(locale)) return 'tier1'
  if (PRICING_TIERS.tier3.includes(locale)) return 'tier3'
  return 'tier2' // default
}

const calculateStarPrice = (credits, locale) => {
  const tier = getPricingTier(locale)
  const multiplier = TIER_MULTIPLIERS[tier]

  // Check for predefined packages first
  if (CREDIT_PACKAGES[credits]) {
    return Math.round(CREDIT_PACKAGES[credits].stars * multiplier)
  }

  // For custom amounts: base 25 stars per credit
  const basePrice = credits * 25
  return Math.round(basePrice * multiplier)
}

const donate = async (ctx) => {
  const amount = parseInt(ctx.scene.state.amount) || (ctx.match && parseInt(ctx.match[1]))

  if (isNaN(amount)) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  if (amount < 1) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  if (amount > 1000) {
    return ctx.replyWithHTML(ctx.i18n.t('donate.invalid_amount'))
  }

  const locale = ctx.i18n.locale()
  const price = amount * 0.5 // USD price for crypto payments
  const starPrice = calculateStarPrice(amount, locale)

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

  const locale = ctx.i18n.locale()

  // Calculate prices for each package based on user's region
  const prices = {
    1: calculateStarPrice(1, locale),
    3: calculateStarPrice(3, locale),
    5: calculateStarPrice(5, locale),
    10: calculateStarPrice(10, locale),
    25: calculateStarPrice(25, locale)
  }

  await ctx.replyWithHTML(ctx.i18n.t('donate.menu', {
    titleSuffix: ` :: @${ctx.options.username}`,
    balance: ctx.session.userInfo.balance
  }), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.callbackButton(`1 Credit — ${prices[1]} ⭐`, 'donate:1')],
      [Markup.callbackButton(`3 Credits — ${prices[3]} ⭐`, 'donate:3')],
      [Markup.callbackButton(`5 Credits — ${prices[5]} ⭐ (-20%)`, 'donate:5')],
      [Markup.callbackButton(`10 Credits — ${prices[10]} ⭐ (-30%)`, 'donate:10')],
      [Markup.callbackButton(`25 Credits — ${prices[25]} ⭐ (-40%)`, 'donate:25')],
    ])
  })
})

module.exports = donateScene
module.exports.calculateStarPrice = calculateStarPrice
module.exports.getPricingTier = getPricingTier
module.exports.CREDIT_PACKAGES = CREDIT_PACKAGES
module.exports.PRICING_TIERS = PRICING_TIERS
