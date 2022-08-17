require('dotenv').config({ path: './.env' })
const Telegram = require('telegraf/telegram')
const {
  db
} = require('./database')

const telegram = new Telegram(process.env.BOT_TOKEN)

(async () => {
  const stickers = db.Sticker.find({
    // fileUniqueId: { $exists: false },
  }).cursor()

  for (let sticker = stickers.next(); sticker != null; sticker = stickers.next()) {
    const stickerInfo = await sticker

    const file = await telegram.getFile(stickerInfo.fileId)

    stickerInfo.fileId = file.file_id
    stickerInfo.fileUniqueId = file.file_unique_id
    stickerInfo.save()

    console.log(stickerInfo.fileUniqueId)
  }
})()
