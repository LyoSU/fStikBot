const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const {
  match
} = require('telegraf-i18n')

// The selected pack can belong to somebody else: /public and the co-edit link
// let a stranger select a pack they don't own. The owner and co-editors (anyone
// who got in via the secret /coedit passcode) may change pack-wide settings;
// the shared demo pack (passcode 'public', selectable by everyone) may not.
const canEditPackSettings = (ctx, stickerSet) => {
  if (!stickerSet) return false
  const ownerId = stickerSet.owner && stickerSet.owner.toString()
  if (ownerId && ownerId === ctx.session.userInfo.id.toString()) return true
  return stickerSet.passcode !== 'public'
}

const packFrame = new Scene('packFrame')

packFrame.enter(async (ctx) => {
  if (!ctx.session.userInfo.stickerSet) {
    await ctx.scene.leave()
    return ctx.replyWithHTML(ctx.i18n.t('scenes.frame.no_sticker_set'), {
      reply_markup: {
        remove_keyboard: true
      }
    })
  }

  await ctx.replyWithHTML(ctx.i18n.t('scenes.frame.select_type', {
    example: 'https://telegra.ph/file/5267f02e571399ba02b84.png'
  }), {
    reply_markup: Markup.keyboard([
      [
        ctx.i18n.t('scenes.frame.types.lite'),
        ctx.i18n.t('scenes.frame.types.medium'),
        ctx.i18n.t('scenes.frame.types.rounded')
      ],
      [
        ctx.i18n.t('scenes.frame.types.square'),
        ctx.i18n.t('scenes.frame.types.circle')
      ],
      [
        { text: ctx.i18n.t('scenes.btn.cancel'), style: 'danger' }
      ]
    ]).resize()
  })
})

packFrame.hears([
  match('scenes.frame.types.rounded'),
  match('scenes.frame.types.circle'),
  match('scenes.frame.types.square'),
  match('scenes.frame.types.lite'),
  match('scenes.frame.types.medium')
], async (ctx) => {
  if (!ctx.session?.userInfo?.stickerSet) {
    await ctx.scene.leave()
    return ctx.replyWithHTML(ctx.i18n.t('scenes.frame.no_sticker_set'), {
      reply_markup: {
        remove_keyboard: true
      }
    })
  }

  if (!canEditPackSettings(ctx, ctx.session.userInfo.stickerSet)) {
    await ctx.scene.leave()
    return ctx.replyWithHTML(ctx.i18n.t('error.access_denied'), {
      reply_markup: {
        remove_keyboard: true
      }
    })
  }

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
    case ctx.i18n.t('scenes.frame.types.medium'):
      type = 'medium'
      break
  }

  const updateResulet = await ctx.db.StickerSet.updateOne({
    _id: ctx.session.userInfo.stickerSet._id
  }, {
    $set: {
      frameType: type
    }
  })

  ctx.session.userInfo.stickerSet.frameType = type

  await ctx.scene.leave()

  if (updateResulet.ok || updateResulet.acknowledged) {
    await ctx.replyWithHTML(ctx.i18n.t('scenes.frame.selected', {
      type: ctx.i18n.t(`scenes.frame.types.${type}`)
    }), {
      reply_markup: {
        remove_keyboard: true
      }
    })
  } else {
    // Previously a falsy `ok` left the user staring at the frame keyboard with
    // no reply at all.
    await ctx.replyWithHTML(ctx.i18n.t('error.unknown'), {
      reply_markup: {
        remove_keyboard: true
      }
    })
  }
})

module.exports = [
  packFrame
]
