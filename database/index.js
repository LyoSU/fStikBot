const collections = require('./models')
const connection = require('./connection')


const db = {}

Object.keys(collections).forEach((collectionName) => {
  db[collectionName] = connection.model(collectionName, collections[collectionName])
})

db.User.updateData = (tgUser) => new Promise(async (resolve, reject) => {
  let telegramId = tgUser.id

  if (tgUser.telegram_id) telegramId = tgUser.telegram_id

  let user = await db.User.findOne({ telegram_id: telegramId })

  if (!user) {
    user = new db.User()
    user.telegram_id = tgUser.id
  }
  user.first_name = tgUser.first_name
  user.last_name = tgUser.last_name
  user.username = tgUser.username
  user.updatedAt = new Date()
  await user.save()

  resolve(user)
})

db.StickerSet.newSet = (stickerSetInfo) => new Promise(async (resolve, reject) => {
  const stickerSet = new db.StickerSet()

  stickerSet.owner = stickerSetInfo.owner
  stickerSet.name = stickerSetInfo.name
  stickerSet.title = stickerSetInfo.title
  stickerSet.emojiSufix = stickerSetInfo.emojiSufix
  stickerSet.create = stickerSetInfo.create || false
  stickerSet.save()

  resolve(stickerSet)
})

db.StickerSet.getSet = (stickerSetInfo) => new Promise(async (resolve, reject) => {
  let stickerSet = await db.StickerSet.findOne({ name: stickerSetInfo.name })

  if (!stickerSet) {
    stickerSet = db.StickerSet.newSet(stickerSetInfo)
  }

  resolve(stickerSet)
})

db.Sticker.addSticker = (stickerSet, emojis, md5, info, file) => new Promise(async (resolve, reject) => {
  const sticker = new db.Sticker()

  sticker.stickerSet = stickerSet
  sticker.fileId = info.file_id
  sticker.emojis = emojis
  sticker.hash.md5 = md5
  sticker.info = info
  sticker.file = file
  sticker.save()

  resolve(sticker)
})

module.exports = {
  db,
}
