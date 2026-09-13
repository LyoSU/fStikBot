const Stage = require('telegraf/stage')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const metrics = require('../utils/metrics')

const { match } = I18n

const broadcast = require('./broadcast')
const sceneNewPack = require('./pack-new')
const originalSticker = require('./sticker-original')
const deleteSticker = require('./sticker-delete')
const packEdit = require('./admin-pack')
const adminPackBulkDelete = require('./admin-pack-bulk-delete')
const photoClear = require('./photo-clear')
const videoRound = require('./video-round')
const packCatalog = require('./pack-catalog')
const packFrame = require('./pack-frame')
const packRename = require('./pack-rename')
const packDelete = require('./pack-delete')
const packAbout = require('./pack-about')
const donate = require('./donate')
const mosaic = require('./mosaic')

const stage = new Stage([].concat(
  sceneNewPack,
  originalSticker,
  deleteSticker,
  broadcast,
  packEdit,
  adminPackBulkDelete,
  photoClear,
  videoRound,
  packCatalog,
  packFrame,
  packRename,
  packDelete,
  packAbout,
  donate,
  mosaic
))

const leaveScene = async (ctx) => {
  ctx.session.scene = null
  await ctx.scene.leave()
}

stage.use((ctx, next) => {
  if (!ctx.session.scene) ctx.session.scene = {}
  return next()
})

stage.hears([/^\/cancel(@\w+)?$/, match('scenes.btn.cancel')], async (ctx) => {
  await leaveScene(ctx)

  // One short message. It used to be followed by the whole welcome banner.
  return ctx.reply(ctx.i18n.t('scenes.leave'), {
    reply_markup: { remove_keyboard: true },
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true
  })
})

// Any command abandons the running scene and is then handled as usual. This
// was a hand-kept list of command names that had already drifted from the
// commands that exist.
stage.use(async (ctx, next) => {
  const entity = ctx.message?.entities?.[0]
  if (entity?.type === 'bot_command' && entity.offset === 0 && ctx.scene.current) {
    await leaveScene(ctx)
  }
  return next()
})

// Buttons that work the same inside a scene, so pressing one doesn't abandon it
// — including the ones scenes put on their own results (/about's download and
// "all packs", /clear's and /round's "Add to pack").
const SCENE_SAFE_CALLBACK = /^(delete_sticker|restore_sticker|donate:buy|news:close|add_sticker|download_original|show_all_packs)(:|$)/

// Runs after the stage (see bot/commands.js): whatever the current scene didn't
// handle arrives here. Telegraf would pass it on to the global handlers while
// the scene stays active — a photo sent during /round went into the pack, and
// a menu button pressed during /new left the next message to be read as the
// pack title.
stage.guard = async (ctx, next) => {
  if (ctx.chat?.type !== 'private' || !ctx.scene?.current) return next()

  if (ctx.callbackQuery) {
    // A button from another message: the user moved on.
    if (!SCENE_SAFE_CALLBACK.test(ctx.callbackQuery.data || '')) await leaveScene(ctx)
    return next()
  }

  if (!ctx.message || ctx.message.successful_payment) return next()

  metrics.track(`scene_hint_${ctx.scene.current.id}`)
  return ctx.replyWithHTML(ctx.i18n.t('scenes.unexpected'), {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true,
    reply_markup: Markup.keyboard([
      [{ text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }]
    ]).resize()
  })
}

module.exports = stage
