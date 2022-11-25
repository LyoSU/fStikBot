const Stage = require('telegraf/stage')
const I18n = require('telegraf-i18n')
const {
  handleStart
} = require('../handlers')

const { match } = I18n

const messaging = require('./messaging')
const sceneNewPack = require('./pack-new')
const originalSticker = require('./sricker-original')
const packEdit = require('./admin-pack')
const searchStickerSet = require('./pack-search')
const packCatalog = require('./pack-catalog')
const packFrame = require('./pack-frame')

const stage = new Stage([].concat(
  sceneNewPack,
  originalSticker,
  messaging,
  packEdit,
  searchStickerSet,
  packCatalog,
  packFrame
))

stage.use((ctx, next) => {
  if (!ctx.session.scene) ctx.session.scene = {}
  return next()
})

stage.hears(([
  '/cancel',
  match('scenes.btn.cancel')
]), async (ctx) => {
  ctx.session.scene = null
  await ctx.reply(ctx.i18n.t('scenes.leave'), {
    reply_markup: {
      remove_keyboard: true
    },
    reply_to_message_id: ctx.message.message_id
  })
  ctx.scene.leave()
  handleStart(ctx)
})

stage.hears(([
  '/start',
  '/help',
  '/packs',
  '/emoji',
  '/lang',
  '/donate',
  '/publish'
]), async (ctx, next) => {
  await ctx.scene.leave()
  ctx.session.scene = null
  await next()
})
stage.middleware()

module.exports = stage
