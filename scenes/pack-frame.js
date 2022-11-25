const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const {
  match
} = require('telegraf-i18n')

const packFrame = new Scene('packFrame')

packFrame.enter(async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('scenes.frame.select_type', {
    example: 'https://telegra.ph/file/7cb167d5fe01bf29a8e2c.png'
  }), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.frame.types.square'),
        ctx.i18n.t('scenes.frame.types.lite')
      ],
      [
        ctx.i18n.t('scenes.frame.types.rounded'),
        ctx.i18n.t('scenes.frame.types.circle')
      ],
      [
        ctx.i18n.t('scenes.btn.cancel')
      ]
    ]).resize()
  })
})

packFrame.hears([
  match('scenes.frame.types.rounded'),
  match('scenes.frame.types.circle'),
  match('scenes.frame.types.square'),
  match('scenes.frame.types.lite')
], async (ctx) => {
  let type

  switch (ctx.message.text) {
    case ctx.i18n.t('scenes.frame.types.rounded'):
      type = 'rounded'
      break
    case ctx.i18n.t('scenes.frame.types.circle'):
      type = 'circle'
      break
    case ctx.i18n.t('scenes.frame.types.square'):
      type = 'square'
      break
    case ctx.i18n.t('scenes.frame.types.lite'):
      type = 'lite'
      break
  }

  const updateResulet = await ctx.db.StickerSet.updateOne({
    _id: ctx.session?.userInfo?.stickerSet._id
  }, {
    $set: {
      frameType: type
    }
  })

  if (updateResulet.ok) {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.frame.selected', {
      type: ctx.i18n.t(`scenes.frame.types.${type}`)
    }), {
      reply_markup: {
        remove_keyboard: true
      }
    })
  }
})

module.exports = [
  packFrame
]
