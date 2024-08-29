
const Scene = require('telegraf/scenes/base')
const Markup = require('telegraf/markup')
const { escapeHTML } = require('../utils')

const adminPackBulkDelete = new Scene('adminPackBulkDelete')

adminPackBulkDelete.enter(async (ctx) => {
  const welcomeText = `
Bulk Delete Sticker Packs

This tool allows you to delete multiple sticker packs and custom emoji sets based on the links provided in your message.

⚠️ Warning: This action is irreversible. Use with caution.

To proceed, please send me a message containing links to the sticker packs you want to delete.
The links can be visible or hidden in the message entities.
Or click "Cancel" to go back.
  `

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton('❌ Cancel', 'admin:pack:bulk_delete:cancel')]
  ])

  await ctx.replyWithHTML(welcomeText, { reply_markup: replyMarkup })
})

adminPackBulkDelete.on('message', async (ctx) => {
  const message = ctx.message
  const entities = message.entities || message.caption_entities || []
  const text = message.text || message.caption || ''

  const links = new Set()

  // Extract links from visible text
  const visibleLinks = text.match(/https?:\/\/t\.me\/addstickers\/\w+/g) || []
  visibleLinks.forEach(link => links.add(link))

  // Extract links from entities
  entities.forEach(entity => {
    if (entity.type === 'text_link') {
      if (entity.url.startsWith('https://t.me/addstickers/')) {
        links.add(entity.url)
      }
    } else if (entity.type === 'url') {
      const url = text.slice(entity.offset, entity.offset + entity.length)
      if (url.startsWith('https://t.me/addstickers/')) {
        links.add(url)
      }
    }
  })

  if (links.size === 0) {
    return ctx.replyWithHTML('❌ No valid sticker pack links found in your message. Please try again with valid links.')
  }

  const stickerSetNames = Array.from(links).map(link => link.split('/').pop())

  const confirmText = `
Found ${stickerSetNames.length} sticker pack(s) in your message:

${stickerSetNames.map(name => `• ${escapeHTML(name)}`).join('\n')}

Are you sure you want to delete all these packs?

⚠️ This action cannot be undone!
  `

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('✅ Yes, delete all', 'admin:pack:bulk_delete:confirm'),
      Markup.callbackButton('❌ No, cancel', 'admin:pack:bulk_delete:cancel')
    ]
  ])

  ctx.session.stickerSetsToDelete = stickerSetNames

  await ctx.replyWithHTML(confirmText, { reply_markup: replyMarkup })
})

adminPackBulkDelete.action('admin:pack:bulk_delete:confirm', async (ctx) => {
  const stickerSetNames = ctx.session.stickerSetsToDelete

  if (!stickerSetNames || stickerSetNames.length === 0) {
    return ctx.answerCbQuery('❌ No sticker sets to delete. Operation cancelled.', true)
  }

  let deletedCount = 0
  let errorCount = 0

  for (const setName of stickerSetNames) {
    try {
      const stickerSet = await ctx.telegram.getStickerSet(setName)
      for (const sticker of stickerSet.stickers) {
        await ctx.telegram.deleteStickerFromSet(sticker.file_id).catch(() => {})
      }
      deletedCount++
    } catch (error) {
      console.error(`Error deleting sticker set ${setName}:`, error)
      errorCount++
    }
  }

  const resultText = `
Operation completed:
✅ Successfully deleted: ${deletedCount} pack(s)
❌ Failed to delete: ${errorCount} pack(s)

Total packs processed: ${stickerSetNames.length}
  `

  await ctx.answerCbQuery()
  await ctx.replyWithHTML(resultText)
  delete ctx.session.stickerSetsToDelete
  return ctx.scene.leave()
})

adminPackBulkDelete.action('admin:pack:bulk_delete:cancel', async (ctx) => {
  await ctx.answerCbQuery('Operation cancelled')
  delete ctx.session.stickerSetsToDelete
  return ctx.scene.leave()
})

adminPackBulkDelete.on('callback_query', async (ctx) => {
  await ctx.answerCbQuery('Unknown action')
})

adminPackBulkDelete.on('message', async (ctx) => {
  await ctx.reply('Please send links to sticker packs or use the buttons provided.')
})

module.exports = adminPackBulkDelete
