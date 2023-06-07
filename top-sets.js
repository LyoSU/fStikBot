const Telegram = require('telegraf/telegram')
const cron = require('node-cron')
const { atlasDb } = require('./database')
const { escapeHTML } = require('./utils')

const telegram = new Telegram(process.env.BOT_TOKEN)
const config = require('./config')

// Define a function to get the most popular sticker packs in a week
async function getPopularStickerPacks () {
  const timeAgo = new Date().setDate(new Date().getDate() - 30)

  const popularStickerPacks = await atlasDb
    .StickerSet
    .find({
      'about.safe': true,
      'installations.month': { $gt: 0 },
      'reaction.total': { $gt: 5 },
      publishDate: { $gte: timeAgo },
      stickerChannel: { $exists: false },
      $and: [
        { 'about.description': { $ne: null } },
        { 'about.description': { $ne: '' } }
      ]
    })
    .sort({ 'reaction.total': -1 })
    .limit(1)
  return popularStickerPacks
}

// Define a function to post the most popular sticker packs to a channel
async function postPopularStickerPacksToChannel () {
  const popularStickerPacks = await getPopularStickerPacks()
  for (const stickerPack of popularStickerPacks) {
    const stickerSet = await telegram.getStickerSet(stickerPack.name)

    let title = stickerSet.title

    // remove (@username) or :: @username from the title
    title = title.replace(/\s\(@\w+\)/, '')
    title = title.replace(/::\s@\w+/, '')
    title = title.replace(/@/, '')

    let about = `${stickerPack.about.description}`

    // remove Stickers from Stickers.Wiki from the about
    about = about.replace(/Stickers from Stickers.Wiki/, '').trim()

    const message = `<b>${escapeHTML(title)}</b>\n${escapeHTML(about)}`

    // get random sticker from the sticker pack
    const sticker = stickerSet.stickers[Math.floor(Math.random() * stickerSet.stickers.length)]

    const bot = await telegram.getMe()

    const stickerMessageId = await telegram.sendSticker(config.stickerChannelId, sticker.file_id, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `👍 ${stickerPack.reaction.total}`,
              url: `https://t.me/${bot.username}/catalog?startApp=set=${stickerSet.name}&startapp=set=${stickerSet.name}`
            }
          ]
        ]
      }
    })

    await telegram.sendMessage(config.stickerChannelId, message, {
      parse_mode: 'HTML'
    })

    stickerPack.stickerChannel = {
      messageId: stickerMessageId.message_id
    }

    await stickerPack.save()
  }
}

if (config.stickerChannelId) {
  cron.schedule('0 */2 * * *', () => postPopularStickerPacksToChannel()) // every 2 hours

  const updateMessage = async () => {
    const stickerPacks = await atlasDb.StickerSet.find({ 'stickerChannel.messageId': { $gt: 0 } })

    for (const stickerPack of stickerPacks) {
      const stickerSet = await telegram.getStickerSet(stickerPack.name)
      const bot = await telegram.getMe()

      const inlineKeyboard = [
        {
          text: `👍 ${stickerPack.reaction.total}`,
          url: `https://t.me/${bot.username}/catalog?startApp=set=${stickerSet.name}&startapp=set=${stickerSet.name}`
        }
      ]

      await telegram.editMessageReplyMarkup(config.stickerChannelId, stickerPack.stickerChannel.messageId, null, {
        inline_keyboard: [inlineKeyboard]
      }).catch(() => {})

      await new Promise(resolve => setTimeout(resolve, 3000))
    }

    updateMessage()
  }

  updateMessage()
}
