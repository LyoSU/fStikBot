module.exports = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.search_catalog'), {
    reply_markup: JSON.stringify({
      inline_keyboard: [
        [
          {
            text: ctx.i18n.t('cmd.start.btn.catalog'),
            url: ctx.config.catalogUrl
          }
        ],
        [
          {
            text: ctx.i18n.t('cmd.start.btn.catalog_app'),
            url: ctx.config.catalogAppUrl
          }
        ],
        [
          {
            text: ctx.i18n.t('cmd.start.commands.publish'),
            callback_data: 'publish'
          }
        ],
        [
          {
            text: ctx.i18n.t('cmd.start.commands.original'),
            callback_data: 'original'
          },
          {
            text: ctx.i18n.t('cmd.start.commands.info'),
            callback_data: 'about'
          }
        ]
      ]
    })
  })
}