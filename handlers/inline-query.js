const Composer = require('telegraf/composer')

const composer = new Composer()

composer.on('inline_query', async (ctx) => {
  const offset = parseInt(ctx.inlineQuery.offset) || 0
  const limit = 50
  const stickersResult = []

  let inlineSet = ctx.session.userInfo.inlineStickerSet

  if (!inlineSet) {
    inlineSet = await ctx.db.StickerSet.findOne({
      owner: ctx.session.userInfo.id,
      inline: true
    })
  }

  let searchStickers = []

  if (ctx.inlineQuery.query.length >= 1) {
    const search = await ctx.db.StickerSet.findOne({
      owner: ctx.session.userInfo.id,
      inline: true,
      $text: { $search: ctx.inlineQuery.query }
    })

    if (search) inlineSet = search
    else {
      const userStickerSet = await ctx.db.StickerSet.find({
        owner: ctx.session.userInfo.id,
        hide: false
      })

      searchStickers = await ctx.db.Sticker.find({
        deleted: false,
        stickerSet: { $in: userStickerSet },
        $text: { $search: ctx.inlineQuery.query }
      }).limit(limit).skip(offset)
    }
  }

  if (searchStickers.length <= 0) {
    searchStickers = await ctx.db.Sticker.find({
      deleted: false,
      stickerSet: inlineSet,
    }).limit(limit).skip(offset)
  }

  for (const sticker of searchStickers) {
    if (!sticker.info.stickerType) {
      const fileInfo = await ctx.tg.getFile(sticker.info.file_id)
      if (/document/.test(fileInfo.file_path)) sticker.info.stickerType = 'document'
      else if (/photo/.test(fileInfo.file_path)) sticker.info.stickerType = 'photo'
      else sticker.info.stickerType = 'sticker'
      await sticker.save()
    }
    if (sticker.info.stickerType === 'animation') sticker.info.stickerType = 'mpeg4_gif'
    let fieldFileIdName = sticker.info.stickerType + '_file_id'
    if (sticker.info.stickerType === 'mpeg4_gif') fieldFileIdName = 'mpeg4_file_id'

    const data = {
      type: sticker.info.stickerType,
      id: sticker._id,
      title: sticker.info.caption || sticker.info.stickerType
    }
    data[fieldFileIdName] = sticker.info.file_id

    stickersResult.push(data)
  }

  ctx.state.answerIQ = [stickersResult, {
    is_personal: true,
    cache_time: 0,
    next_offset: offset + limit,
    switch_pm_text: ctx.i18n.t('cmd.inline.switch_pm'),
    switch_pm_parameter: 'inline_pack'
  }]
})

module.exports = composer
