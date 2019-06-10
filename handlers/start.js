const { userName } = require('../utils')


module.exports = async (ctx) => {
  ctx.replyWithHTML(ctx.i18n.t('cmd.start', {
    name: userName(ctx.from),
  }))
}
