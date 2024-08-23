const Stage = require('telegraf/stage')
const I18n = require('telegraf-i18n')
const {
  handleStart
} = require('../handlers')

const { match } = I18n

const messaging = require('./messaging')
const sceneNewPack = require('./pack-new')
const originalSticker = require('./sticker-original')
const deleteSticker = require('./sticker-delete')
const packEdit = require('./admin-pack')
const adminPackBulkDelete = require('./admin-pack-bulk-delete')
const searchStickerSet = require('./pack-search')
const photoClear = require('./photo-clear')
const packCatalog = require('./pack-catalog')
const packFrame = require('./pack-frame')
const packRename = require('./pack-rename')
const packDelete = require('./pack-delete')
const packAbout = require('./pack-about')
const donate = require('./donate')

const stage = new Stage([].concat(
  sceneNewPack,
  originalSticker,
  deleteSticker,
  messaging,
  packEdit,
  adminPackBulkDelete,
  searchStickerSet,
  photoClear,
  packCatalog,
  packFrame,
  packRename,
  packDelete,
  packAbout,
  donate
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
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
  await ctx.scene.leave()

  return handleStart(ctx)
})

stage.hears(([
  '/start',
  '/help',
  '/packs',
  '/emoji',
  '/lang',
  '/donate',
  '/publish',
  '/delete',
  '/frame',
  '/rename',
  '/catalog'
]), async (ctx, next) => {
  await ctx.scene.leave()
  ctx.session.scene = null
  await next()
})
stage.middleware()

module.exports = stage
