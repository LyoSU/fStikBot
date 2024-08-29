const Markup = require('telegraf/markup')
const Scene = require('telegraf/scenes/base')
const { escapeHTML } = require('../utils')

const adminPackFind = new Scene('adminPackFind')

adminPackFind.enter(async (ctx) => {
  const welcomeText = `
<b>Welcome to the Admin Sticker Pack Management!</b>

To manage a sticker pack or custom emoji set, please send me:
• A sticker from the pack
• A custom emoji from the set
• The pack's share URL (e.g., https://t.me/addstickers/packname or https://t.me/addemoji/setname)
• Or simply the pack/set name

I'll help you view, edit, or remove the pack/set.
  `

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton('🏠 Back to Admin Menu', 'admin:menu')]
  ])

  await ctx.replyWithHTML(welcomeText, {
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminPackFind.on(['sticker', 'text', 'custom_emoji'], async (ctx) => {
  const { sticker, text, custom_emoji } = ctx.message
  let packName

  if (sticker) {
    packName = sticker.set_name
  } else if (custom_emoji) {
    packName = custom_emoji.set_name
  } else if (text) {
    const urlMatch = text.match(/(?:addstickers|addemoji)\/(.+)/)
    if (urlMatch) {
      packName = urlMatch[1]
    } else {
      packName = text.trim()
    }
  }

  if (!packName) {
    return ctx.replyWithHTML('❌ Invalid input. Please send a sticker, custom emoji, pack URL, or pack name.')
  }

  try {
    let stickerSet
    try {
      stickerSet = await ctx.telegram.getStickerSet(packName)
    } catch (error) {
      // If getStickerSet fails, try getCustomEmojiStickers
      const customEmojiStickers = await ctx.telegram.getCustomEmojiStickers([packName.split('_')[0]])
      if (customEmojiStickers && customEmojiStickers.length > 0) {
        stickerSet = {
          name: packName,
          title: 'Custom Emoji Set',
          is_emoji: true,
          stickers: customEmojiStickers
        }
      } else {
        throw new Error('Sticker set or custom emoji set not found')
      }
    }

    const info = await ctx.db.StickerSet.findOne({ name: packName })

    if (!stickerSet) {
      return ctx.replyWithHTML('❌ Sticker pack or custom emoji set not found. Please check the name and try again.')
    }

    if (packName.split('_').pop() !== ctx.options.username) {
      return ctx.replyWithHTML('⚠️ This pack/set is not managed by this bot. You can only manage packs/sets created with this bot.')
    }

    ctx.session.admin = { editPack: stickerSet, info }
    await ctx.scene.enter('adminPackEdit')
  } catch (error) {
    console.error('Error fetching sticker set or custom emoji set:', error)
    return ctx.replyWithHTML('❌ An error occurred while fetching the pack/set. Please try again later.')
  }
})

const adminPackEdit = new Scene('adminPackEdit')

adminPackEdit.enter(async (ctx) => {
  const { editPack, info } = ctx.session.admin

  if (!editPack) {
    return ctx.scene.enter('adminPackFind')
  }

  const packOwner = await ctx.db.User.findById(info?.owner)
  const resultText = `
<b>${editPack.is_emoji ? 'Custom Emoji Set' : 'Sticker Pack'} Details:</b>

📦 Name: <code>${escapeHTML(editPack.name)}</code>
🏷 Title: ${escapeHTML(editPack.title)}
👤 Owner: <a href="tg://user?id=${packOwner?.telegram_id}">${escapeHTML(packOwner?.first_name)}</a>
🖼 ${editPack.is_emoji ? 'Emojis' : 'Stickers'}: ${editPack.stickers.length}

What would you like to do with this ${editPack.is_emoji ? 'set' : 'pack'}?
  `

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('🔄 Change Owner', 'admin:pack:edit:change_owner'),
      Markup.callbackButton('🗑 Remove', 'admin:pack:edit:remove')
    ],
    [Markup.callbackButton('🔙 Back to Search', 'admin:pack:find')]
  ])

  await ctx.replyWithHTML(resultText, { reply_markup: replyMarkup }).catch(() => {})
})

adminPackEdit.action('admin:pack:edit:change_owner', async (ctx) => {
  await ctx.answerCbQuery()
  await ctx.replyWithHTML('👤 To change the owner, please send me the Telegram ID of the new owner.')
  ctx.scene.state.awaitingNewOwner = true
})

adminPackEdit.on('text', async (ctx) => {
  if (ctx.scene.state.awaitingNewOwner) {
    const newOwnerId = ctx.message.text.trim()
    const newOwner = await ctx.db.User.findOne({ telegram_id: newOwnerId })

    if (!newOwner) {
      return ctx.replyWithHTML('❌ User not found. Please check the ID and try again.')
    }

    const { info } = ctx.session.admin
    info.owner = newOwner._id
    await info.save()

    await ctx.replyWithHTML(`✅ ${info.is_emoji ? 'Set' : 'Pack'} owner has been changed to <a href="tg://user?id=${newOwner.telegram_id}">${escapeHTML(newOwner.first_name)}</a>`)
    ctx.scene.state.awaitingNewOwner = false
    return ctx.scene.reenter()
  }
})

adminPackEdit.action('admin:pack:edit:remove', async (ctx) => {
  const { editPack } = ctx.session.admin

  const confirmText = `
⚠️ <b>Warning: ${editPack.is_emoji ? 'Custom Emoji Set' : 'Sticker Pack'} Removal</b>

You are about to remove the ${editPack.is_emoji ? 'set' : 'pack'} "${escapeHTML(editPack.title)}".
This action cannot be undone.

Are you sure you want to proceed?
  `

  const replyMarkup = Markup.inlineKeyboard([
    [
      Markup.callbackButton('✅ Yes, remove', 'admin:pack:edit:remove:confirm'),
      Markup.callbackButton('❌ No, cancel', 'admin:pack:edit:remove:cancel')
    ]
  ])

  await ctx.editMessageText(confirmText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

adminPackEdit.action('admin:pack:edit:remove:confirm', async (ctx) => {
  const { editPack } = ctx.session.admin

  try {
    const stickerSet = await ctx.telegram.getStickerSet(editPack.name)

    for (const sticker of stickerSet.stickers) {
      await ctx.telegram.deleteStickerFromSet(sticker.file_id).catch(() => {})
      await ctx.db.Sticker.deleteOne({ fileUniqueId: sticker.file_unique_id })
    }

    await ctx.answerCbQuery(`✅ ${editPack.is_emoji ? 'Custom emoji set' : 'Sticker pack'} has been successfully removed`, true)
    await ctx.replyWithHTML(`✅ The ${editPack.is_emoji ? 'custom emoji set' : 'sticker pack'} "${escapeHTML(editPack.title)}" has been removed.`)
    return ctx.scene.enter('adminPackFind')
  } catch (error) {
    console.error('Error removing sticker pack or custom emoji set:', error)
    await ctx.answerCbQuery('❌ There was an error removing the pack/set', true).catch(() => {})
    await ctx.replyWithHTML('❌ An error occurred while removing the pack/set. Please try again later.')
  }
})

adminPackEdit.action('admin:pack:edit:remove:cancel', async (ctx) => {
  await ctx.answerCbQuery('Operation cancelled')
  return ctx.scene.reenter()
})

adminPackEdit.action('admin:pack:find', async (ctx) => {
  await ctx.answerCbQuery()
  return ctx.scene.enter('adminPackFind')
})

module.exports = [
  adminPackFind,
  adminPackEdit
]
