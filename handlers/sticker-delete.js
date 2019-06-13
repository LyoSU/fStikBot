module.exports = async (ctx) => {
  ctx.answerCbQuery()

  const user = await ctx.db.User.findOne({ telegram_id: ctx.from.id })
  const sticker = await ctx.db.Sticker.findOne({
    'info.file_id': ctx.match[2],
  }).populate('stickerSet')

  if (sticker.stickerSet.owner.toString() === user.id.toString()) {
    const deleteStickerFromSet = await ctx.deleteStickerFromSet(sticker.info.file_id).catch((error) => {
      console.log(error)
    })

    if (deleteStickerFromSet) {
      sticker.deleted = true
      sticker.save()
    }
  }
}
