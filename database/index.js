const collections = require('./models')
const connection = require('./connection')

const db = {
  connection
}

Object.keys(collections).forEach((collectionName) => {
  db[collectionName] = connection.model(collectionName, collections[collectionName])
})

const fileInfoNormalize = (fileInfo) => {
  if (!fileInfo) return {}
  return {
    stickerType: fileInfo.stickerType || null,
    file_id: fileInfo.file_id,
    file_unique_id: fileInfo.file_unique_id
  }
}

db.User.getData = async (tgUser) => {
  let telegramId

  if (tgUser.telegram_id) telegramId = tgUser.telegram_id
  else telegramId = tgUser.id

  let user = await db.User.findOne({ telegram_id: telegramId })
    .populate('stickerSet')
    .populate('inlineStickerSet')
    .populate('animatedStickerSet')

  if (!user) {
    user = new db.User()
    user.telegram_id = tgUser.id
  }

  return user
}

db.User.updateData = async (tgUser) => {
  const user = await db.User.getData(tgUser)

  user.first_name = tgUser.first_name
  user.last_name = tgUser.last_name
  user.username = tgUser.username
  user.updatedAt = new Date()
  await user.save()

  return user
}

db.StickerSet.newSet = async (stickerSetInfo) => {
  const oldStickerSet = await db.StickerSet.findOne({ name: stickerSetInfo.name })

  if (oldStickerSet) {
    await db.Sticker.updateMany(
      { stickerSet: oldStickerSet.id },
      { $set: { deleted: true } }
    )
    await oldStickerSet.remove()
  }

  const stickerSet = new db.StickerSet()

  stickerSet.owner = stickerSetInfo.owner
  stickerSet.name = stickerSetInfo.name
  stickerSet.title = stickerSetInfo.title
  stickerSet.animated = stickerSetInfo.animated || false
  stickerSet.inline = stickerSetInfo.inline || false
  stickerSet.emojiSuffix = stickerSetInfo.emojiSuffix
  stickerSet.create = stickerSetInfo.create || false
  await stickerSet.save()

  return stickerSet
}

db.StickerSet.getSet = async (stickerSetInfo) => {
  let stickerSet = await db.StickerSet.findOne({ name: stickerSetInfo.name })

  if (!stickerSet) {
    stickerSet = db.StickerSet.newSet(stickerSetInfo)
  }

  return stickerSet
}

db.Sticker.addSticker = async (stickerSet, emojis, info, file) => {
  const sticker = new db.Sticker()

  sticker.stickerSet = stickerSet
  sticker.fileId = info.file_id
  sticker.fileUniqueId = info.file_unique_id
  sticker.emojis = emojis
  sticker.info = fileInfoNormalize(info)
  sticker.file = fileInfoNormalize(file)
  await sticker.save()

  return sticker
}

module.exports = {
  db
}
