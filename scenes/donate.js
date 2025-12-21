const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
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

// Create invoice link for a specific credit amount
const createInvoiceForAmount = async (ctx, amount, starPrice) => {
  const payment = new ctx.db.Payment({
    _id: mongoose.Types.ObjectId(),
    user: ctx.session.userInfo._id,
    amount,
    price: starPrice,
    currency: 'XTR',
    paymentSystem: 'telegram',
    status: 'pending'
  })

  await payment.save()

  const invoiceLink = await ctx.telegram.callApi('createInvoiceLink', {
    title: ctx.i18n.t('donate.invoice_title', { amount }),
    description: ctx.i18n.t('donate.description', { amount }),
    payload: payment._id.toString(),
    provider_token: '',
    currency: 'XTR',
    prices: JSON.stringify([{ label: 'Credits', amount: starPrice }])
  })

  return invoiceLink
}

const donateScene = new Scene('donate')

donateScene.enter(async (ctx) => {
  const locale = ctx.i18n.locale()
  const packages = [1, 3, 5, 10, 25]
  const discounts = { 1: '', 3: '', 5: ' (-20%)', 10: ' (-30%)', 25: ' (-40%)' }

  // Calculate prices for each package
  const prices = {}
  for (const amount of packages) {
    prices[amount] = calculateStarPrice(amount, locale)
  }

  // Create invoice links for all packages in parallel
  const invoiceLinks = {}
  await Promise.all(
    packages.map(async (amount) => {
      invoiceLinks[amount] = await createInvoiceForAmount(ctx, amount, prices[amount])
    })
  )

  // Build buttons with direct payment links
  const buttons = packages.map((amount) => {
    const label = amount === 1 ? '1 Credit' : `${amount} Credits`
    return [Markup.urlButton(`${label} — ${prices[amount]} ⭐${discounts[amount]}`, invoiceLinks[amount])]
  })

  await ctx.replyWithHTML(ctx.i18n.t('donate.menu', {
    titleSuffix: ` :: @${ctx.options.username}`,
    balance: ctx.session.userInfo.balance
  }), {
    reply_markup: Markup.inlineKeyboard(buttons)
  })

  return ctx.scene.leave()
})

module.exports = donateScene
module.exports.calculateStarPrice = calculateStarPrice
module.exports.getPricingTier = getPricingTier
module.exports.CREDIT_PACKAGES = CREDIT_PACKAGES
module.exports.PRICING_TIERS = PRICING_TIERS
