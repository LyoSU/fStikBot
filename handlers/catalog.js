module.exports = async (ctx) => {
  await ctx.replyWithHTML('👇', {
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
