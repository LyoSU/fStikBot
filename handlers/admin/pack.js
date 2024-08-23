const Composer = require('telegraf/composer')
const Markup = require('telegraf/markup')

const composer = new Composer()

composer.action(/admin:pack:edit/, (ctx) => ctx.scene.enter('adminPackFind'))

composer.action(/admin:pack:bulk_delete/, (ctx) => ctx.scene.enter('adminPackBulkDelete'))

composer.action(/admin:pack/, async (ctx) => {
  const resultText = `
<b>Admin Pack Management</b>

Choose an option:
• Edit or remove individual packs
• Bulk delete packs by user ID
  `

  const replyMarkup = Markup.inlineKeyboard([
    [Markup.callbackButton('🖊 Edit/Remove Pack', 'admin:pack:edit')],
    [Markup.callbackButton('🗑 Bulk Delete Packs', 'admin:pack:bulk_delete')],
    [Markup.callbackButton('🔙 Back to Admin Menu', 'admin:back')]
  ])

  await ctx.editMessageText(resultText, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  }).catch(() => {})
})

module.exports = composer
