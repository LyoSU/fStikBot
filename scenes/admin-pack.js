const Markup = require('telegraf/markup')
const Scene = require('telegraf/scenes/base')

const adminPackFind = new Scene('adminPackFind')

adminPackFind.enter(async (ctx) => {
  const resultText = ctx.i18n.t('admin.pack.edit.find')

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminPackFind.on(['sticker', 'text'], async (ctx) => {
  const { sticker, text } = ctx.message

  let packName

  if (text) {
    const messageTextMatch = ctx.message.text.match(/(addstickers)\/(.*)/)

    if(!messageTextMatch || !messageTextMatch[2]) {
      return ctx.scene.reenter()
    }

    packName = messageTextMatch[2]
  } else if (sticker) {
    packName = sticker.set_name
  }


  if (packName.split('_').pop(-1) !== ctx.options.username) {
    return ctx.replyWithHTML(ctx.i18n.t('admin.pack.not_found'))
  }

  const stickerSet = await ctx.tg.getStickerSet(packName)

  const info = await ctx.db.StickerSet.findOne({
    name: packName
  })


  if (!stickerSet) {
    return ctx.replyWithHTML(ctx.i18n.t('admin.pack.not_found'))
  }

  ctx.session.admin = {
    editPack: stickerSet,
    info
  }

  await ctx.scene.enter('adminPackEdit')
})

const adminPackEdit = new Scene('adminPackEdit')

adminPackEdit.enter(async (ctx) => {
  const { editPack, info } = ctx.session.admin

  if (!editPack) {
    return ctx.scene.enter('adminPackFind')
  }

  const packOwner = await ctx.db.User.findById(info?.owner)

  const resultText = ctx.i18n.t('admin.pack.edit.found', {
    packName: editPack.name,
    creatorName: packOwner?.first_name,
    packCreatorLink: `tg://user?id=${packOwner?.telegram_id}`
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.pack.edit.steal_button'), 'admin:pack:edit:steal'),
      Markup.callbackButton(ctx.i18n.t('admin.pack.edit.remove_button'), 'admin:pack:edit:remove')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.replyWithHTML(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminPackEdit.action(/^admin:pack:edit:steal$/, async (ctx) => {
  const { editPack, info } = ctx.session.admin

  if (!info) {
    return ctx.scene.enter('adminPackFind')
  }

  const resultText = ctx.i18n.t('admin.pack.edit.steal', {
    packName: editPack.name
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.pack.edit.yes'), 'admin:pack:edit:steal:yes'),
      Markup.callbackButton(ctx.i18n.t('admin.pack.edit.no'), 'admin:pack:edit:steal:no')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminPackEdit.action(/admin:pack:edit:steal:(.*)/, async (ctx) => {
  const { info } = ctx.session.admin

  if (!info) {
    return ctx.scene.enter('adminPackFind')
  }

  const stealType = ctx.match[1]

  if (stealType === 'no') {
    return ctx.scene.enter('adminPackEdit')
  }

  info.owner = ctx.session.userInfo.id
  await info.save()

  await ctx.deleteMessage()

  ctx.state.answerCbQuery = [
    ctx.i18n.t('admin.pack.edit.steal_success', {
      packName: info.name
    }),
    true
  ]

  await ctx.scene.enter('adminPackEdit')
})

adminPackEdit.action(/admin:pack:edit:remove$/, async (ctx) => {
  const { editPack } = ctx.session.admin

  if (!editPack) {
    return ctx.scene.enter('adminPackFind')
  }

  const resultText = ctx.i18n.t('admin.pack.edit.remove', {
    packName: editPack.name
  })

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton(ctx.i18n.t('admin.pack.edit.yes'), 'admin:pack:edit:remove:yes'),
      Markup.callbackButton(ctx.i18n.t('admin.pack.edit.no'), 'admin:pack:edit:remove:no')
    ],
    [
      Markup.callbackButton(ctx.i18n.t('admin.menu.admin'), 'admin:back')
    ]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminPackEdit.action(/admin:pack:edit:remove:(.*)/, async (ctx) => {
  const { editPack } = ctx.session.admin

  if (!editPack) {
    return ctx.scene.enter('adminPackFind')
  }

  const removeType = ctx.match[1]

  if (removeType === 'no') {
    return ctx.scene.enter('adminPackEdit')
  }

  const stickerSet = await ctx.telegram.getStickerSet(editPack.name)

  for (const sticker of stickerSet.stickers) {
    await ctx.telegram.deleteStickerFromSet(sticker.file_id)

    await ctx.db.Sticker.deleteOne({
      fileUniqueId: sticker.file_unique_id
    })
  }

  await ctx.deleteMessage()

  ctx.state.answerCbQuery = [
    ctx.i18n.t('admin.pack.edit.remove_success', {
      packName: editPack.name
    }),
    true
  ]

  await ctx.scene.enter('adminPackEdit')
})

module.exports = [
  adminPackFind,
  adminPackEdit
]
