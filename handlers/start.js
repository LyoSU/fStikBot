const Markup = require('telegraf/markup')
const { userName } = require('../utils')

module.exports = async (ctx) => {
  const commands = [
    { command: 'start', description: ctx.i18n.t('cmd.start.commands.start') },
    { command: 'packs', description: ctx.i18n.t('cmd.start.commands.packs') },
    { command: 'new', description: ctx.i18n.t('cmd.start.commands.new') },
    { command: 'original', description: ctx.i18n.t('cmd.start.commands.original') },
    { command: 'restore', description: ctx.i18n.t('cmd.start.commands.restore') },
    { command: 'copy', description: ctx.i18n.t('cmd.start.commands.copy') },
    // { command: 'emoji', description: ctx.i18n.t('cmd.start.commands.emoji') },
    { command: 'lang', description: ctx.i18n.t('cmd.start.commands.lang') },
    { command: 'donate', description: ctx.i18n.t('cmd.start.commands.donate') }
  ]

  await ctx.telegram.callApi('setMyCommands', {
    commands: JSON.stringify(commands),
    scope: JSON.stringify({
      type: 'chat',
      chat_id: ctx.chat.id
    })
  })

  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.info', {
    name: userName(ctx.from)
  }), Markup.removeKeyboard().extra({ disable_web_page_preview: true }))

  if (ctx.config.catalogUrl/* && ctx.startPayload === 'catalog' */) {
    await ctx.replyWithHTML(/* ctx.i18n.t('cmd.start.catalog') */'👇', {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            {
              text: ctx.i18n.t('cmd.start.btn.catalog'),
              web_app: {
                url: ctx.config.catalogUrl
              }
            }
          ]
        ]
      })
    })
  }
}
