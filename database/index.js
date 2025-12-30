const collections = require('./models')
const {
  connection,
  atlasConnection
} = require('./connection')

const db = {
  connection
}

Object.keys(collections).forEach((collectionName) => {
  db[collectionName] = connection.model(collectionName, collections[collectionName])
})

const atlasDb = {
  connection: atlasConnection
}

Object.keys(collections).forEach((collectionName) => {
  atlasDb[collectionName] = atlasConnection.model(collectionName, collections[collectionName])
})

// Truncate string to max length
const truncate = (str, maxLength) => {
  if (!str) return null
  return str.length > maxLength ? str.substr(0, maxLength) : str
}

db.User.getData = async (tgUser) => {
  let telegramId

  if (tgUser.telegram_id) telegramId = tgUser.telegram_id
  else telegramId = tgUser.id

  // Optimized: single populate call with select for only needed fields
  let user = await db.User.findOne({ telegram_id: telegramId })
    .populate({
      path: 'stickerSet',
      select: '_id name title packType animated video inline create emojiSuffix frameType boost hide owner passcode'
    })
    .populate({
      path: 'inlineStickerSet',
      select: '_id name title inline'
    })

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
      { $set: { deleted: true, deletedAt: new Date() } }
    )
    await oldStickerSet.remove()
  }

  const stickerSet = new db.StickerSet()

  stickerSet.owner = stickerSetInfo.owner
  stickerSet.ownerTelegramId = stickerSetInfo.ownerTelegramId
  stickerSet.name = stickerSetInfo.name
  stickerSet.title = stickerSetInfo.title
  stickerSet.animated = stickerSetInfo.animated || false
  stickerSet.inline = stickerSetInfo.inline || false
  stickerSet.video = stickerSetInfo.video || false
  stickerSet.packType = stickerSetInfo.packType || 'regular'
  stickerSet.emojiSuffix = stickerSetInfo.emojiSuffix
  stickerSet.create = stickerSetInfo.create || false
  stickerSet.boost = stickerSetInfo.boost || false
  await stickerSet.save()

  // Increment user's pack count
  if (stickerSetInfo.owner && stickerSetInfo.create) {
    const countField = stickerSetInfo.inline
      ? 'packsCount.inline'
      : `packsCount.${stickerSetInfo.packType || 'regular'}`
    await db.User.updateOne(
      { _id: stickerSetInfo.owner },
      { $inc: { [countField]: 1 } }
    )
  }

  return stickerSet
}

db.StickerSet.getSet = async (stickerSetInfo) => {
  let stickerSet = await db.StickerSet.findOne({ name: stickerSetInfo.name })

  if (!stickerSet) {
    stickerSet = db.StickerSet.newSet(stickerSetInfo)
  }

  return stickerSet
}

/**
 * Add a new sticker to the database
 * Uses optimized flat structure for new documents (backwards-compatible)
 *
 * @param {ObjectId|string} stickerSet - The sticker set ID
 * @param {string|string[]} emojisText - Emoji(s) associated with the sticker
 * @param {Object} info - Current sticker info from Telegram API
 * @param {Object} [originalFile] - Original file data (if different from current)
 * @returns {Promise<Document>} The created sticker document
 */
db.Sticker.addSticker = async (stickerSet, emojisText = '', info, originalFile = null) => {
  if (!info || !info.file_unique_id) {
    throw new Error('Sticker info with file_unique_id is required')
  }

  const emojis = Array.isArray(emojisText)
    ? emojisText.join(' ')
    : truncate(emojisText, 150)

  const stickerData = {
    stickerSet,
    fileUniqueId: info.file_unique_id,
    emojis,

    // New flat fields (optimized storage)
    fileId: info.file_id,
    stickerType: info.stickerType || null,
    caption: truncate(info.caption, 150)
  }

  // Store original only if provided AND different from current
  if (originalFile && originalFile.file_id && originalFile.file_id !== info.file_id) {
    stickerData.original = {
      fileId: originalFile.file_id,
      fileUniqueId: originalFile.file_unique_id,
      stickerType: originalFile.stickerType || null
    }
  }

  const sticker = new db.Sticker(stickerData)
  await sticker.save()

  return sticker
}

module.exports = {
  db,
  atlasDb
}
