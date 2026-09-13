const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { replyOrEditBanner } = require('../banners')

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
  1: { stars: 25, discount: 0 }, // $0.33 base
  3: { stars: 60, discount: 0.20 }, // $0.78 (20% off)
  5: { stars: 100, discount: 0.20 }, // $1.30 (20% off)
  10: { stars: 175, discount: 0.30 }, // $2.28 (30% off)
  25: { stars: 375, discount: 0.40 } // $4.88 (40% off)
}

const PACKAGES = Object.keys(CREDIT_PACKAGES).map(Number)

const getPricingTier = (locale) => {
  if (PRICING_TIERS.tier1.includes(locale)) return 'tier1'
  if (PRICING_TIERS.tier3.includes(locale)) return 'tier3'
  return 'tier2' // default
}

const calculateStarPrice = (credits, locale) => {
  const multiplier = TIER_MULTIPLIERS[getPricingTier(locale)]
  const stars = CREDIT_PACKAGES[credits] ? CREDIT_PACKAGES[credits].stars : credits * 25
  return Math.round(stars * multiplier)
}

const discountLabel = (amount) => {
  const { discount } = CREDIT_PACKAGES[amount]
  // The 3-credit package has a discount on paper but was never advertised as one.
  return discount && amount > 3 ? ` (-${Math.round(discount * 100)}%)` : ''
}

// The menu only offers packages. The invoice itself (and its pending Payment
// row) is created when the user taps one — see handlers/donate.js. Building
// five invoice links on every menu render created five pending Payments per
// view that nothing ever cleaned up.
const donateScene = new Scene('donate')

donateScene.enter(async (ctx) => {
  const locale = ctx.i18n.locale()

  const buttons = PACKAGES.map((amount) => {
    const label = amount === 1 ? '1 Credit' : `${amount} Credits`
    const price = calculateStarPrice(amount, locale)
    return [Markup.callbackButton(`${label} — ${price} ⭐${discountLabel(amount)}`, `donate:buy:${amount}`)]
  })

  await replyOrEditBanner(ctx, 'donate', ctx.i18n.t('donate.menu', {
    titleSuffix: ` :: @${ctx.options.username}`,
    balance: ctx.session.userInfo.balance
  }), {
    reply_markup: Markup.inlineKeyboard(buttons)
  })

  return ctx.scene.leave()
})

module.exports = donateScene
module.exports.calculateStarPrice = calculateStarPrice
module.exports.CREDIT_PACKAGES = CREDIT_PACKAGES
