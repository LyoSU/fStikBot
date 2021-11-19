const {
  db
} = require('../database')

const privateToInline = async () => {
  const stickerSetCursor = db.StickerSet.find({
    private: true
  }).cursor()

  for (let stickerSet = await stickerSetCursor.next(); stickerSet != null; stickerSet = await stickerSetCursor.next()) {
    stickerSet.set('private', undefined, { strict: false })
    stickerSet.inline = true
    await stickerSet.save()
  }
}

// privateToInline()
