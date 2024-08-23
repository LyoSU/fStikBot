const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { escapeHTML } = require('../utils')

const adminPackBulkDelete = new Scene('adminPackBulkDelete')

adminPackBulkDelete.enter(async (ctx) => {
  const welcomeText = `
<b>Bulk Delete Sticker Packs</b>

This tool allows you to delete all sticker packs and custom emoji sets owned by a specific user.

⚠️ <b>Warning:</b> This action is irreversible. Use with caution.

To proceed, please send me the Telegram ID of the user whose packs you want to delete.
Or click "Cancel" to go back.
  `

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton('❌ Cancel', 'admin:pack:bulk_delete:cancel')]
  ])

  await ctx.replyWithHTML(welcomeText, { reply_markup: replyMarkup })
})

adminPackBulkDelete.on('text', async (ctx) => {
  const userId = ctx.message.text.trim()

  if (!/^\d+$/.test(userId)) {
    return ctx.replyWithHTML('❌ Invalid input. Please send a valid Telegram user ID (numbers only).')
  }

  const user = await ctx.db.User.findOne({ telegram_id: userId })

  if (!user) {
    return ctx.replyWithHTML('❌ User not found. Please check the ID and try again.')
  }

  const stickerSets = await ctx.db.StickerSet.find({ owner: user._id })

  if (stickerSets.length === 0) {
    return ctx.replyWithHTML(`No sticker packs or emoji sets found for user with ID ${escapeHTML(userId)}.`)
  }

  const confirmText = `
Found ${stickerSets.length} pack(s) owned by user ${escapeHTML(user.first_name)} (ID: ${escapeHTML(userId)}).

Are you sure you want to delete all these packs?

⚠️ This action cannot be undone!
  `

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('✅ Yes, delete all', `admin:pack:bulk_delete:confirm:${userId}`),
      Markup.callbackButton('❌ No, cancel', 'admin:pack:bulk_delete:cancel')
    ]
  ])

  await ctx.replyWithHTML(confirmText, { reply_markup: replyMarkup })
})

adminPackBulkDelete.action(/admin:pack:bulk_delete:confirm:(\d+)/, async (ctx) => {
  const userId = ctx.match[1]
  const user = await ctx.db.User.findOne({ telegram_id: userId })

  if (!user) {
    return ctx.answerCbQuery('❌ User not found. Operation cancelled.', true)
  }

  const stickerSets = await ctx.db.StickerSet.find({ owner: user._id })
  let deletedCount = 0
  let errorCount = 0

  for (const set of stickerSets) {
    try {
      const stickerSet = await ctx.telegram.getStickerSet(set.name)
      for (const sticker of stickerSet.stickers) {
        await ctx.telegram.deleteStickerFromSet(sticker.file_id).catch(() => {})
      }
      await ctx.db.StickerSet.deleteOne({ _id: set._id })
      await ctx.db.Sticker.deleteMany({ stickerSet: set._id })
      deletedCount++
    } catch (error) {
      console.error(`Error deleting sticker set ${set.name}:`, error)
      errorCount++
    }
  }

  const resultText = `
Operation completed:
✅ Successfully deleted: ${deletedCount} pack(s)
❌ Failed to delete: ${errorCount} pack(s)

Total packs processed: ${stickerSets.length}
  `

  await ctx.replyWithHTML(resultText)
  return ctx.scene.leave()
})

adminPackBulkDelete.action('admin:pack:bulk_delete:cancel', async (ctx) => {
  await ctx.answerCbQuery('Operation cancelled')
  return ctx.scene.leave()
})

module.exports = adminPackBulkDelete
