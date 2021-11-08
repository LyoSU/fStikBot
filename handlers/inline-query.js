const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')

const composer = new Composer()

composer.on('inline_query', async (ctx) => {
  const stickersResult = []

  const privateSet = await ctx.db.StickerSet.findOne({
    owner: ctx.session.userInfo.id,
    private: true
  })

  const stickers = await ctx.db.Sticker.find({
    stickerSet: privateSet
  })

  stickers.forEach(sticker => {
    if (sticker.info.stickerType === 'animation') sticker.info.stickerType = 'mpeg4_gif'
    let fieldFileIdName = sticker.info.stickerType + '_file_id'
    if (sticker.info.stickerType === 'mpeg4_gif') fieldFileIdName = 'mpeg4_file_id'

    const data = {
      type: sticker.info.stickerType,
      id: sticker._id,
      title: '-'
    }
    data[fieldFileIdName] = sticker.info.file_id

    stickersResult.push(data)
  })

  ctx.state.answerIQ = [stickersResult, {
    is_personal: true,
    cache_time: 5
  }]
})

module.exports = composer
