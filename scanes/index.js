const Stage = require('telegraf/stage')
const I18n = require('telegraf-i18n')
const {
  handleStart,
} = require('../handlers')


const { match } = I18n

const sceneNewPack = require('./pack-new')
const originalSticker = require('./sricker-original')


const stage = new Stage([].concat(sceneNewPack, originalSticker))

stage.use((ctx, next) => {
  if (!ctx.session.scane) ctx.session.scane = {}
  return next()
})

stage.hears((['/cancel', match('scenes.btn.cancel')]), async (ctx) => {
  ctx.session.scane = null
  await ctx.reply(ctx.i18n.t('scenes.leave'), {
    reply_to_message_id: ctx.message.message_id,
  })
  ctx.scene.leave()
  handleStart(ctx)
})
stage.middleware()

module.exports = stage
