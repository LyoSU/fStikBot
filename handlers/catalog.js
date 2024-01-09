module.exports = async (ctx) => {
  await ctx.replyWithHTML(ctx.i18n.t('cmd.start.catalog'), {
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
        ]
        // [
        //   {
        //     text: ctx.i18n.t('cmd.start.btn.catalog_browser'),
        //     login_url: {
        //       url: ctx.config.catalogUrl,
        //       request_write_access: true
        //     }
        //   }
        // ]
      ]
    })
  })
}
