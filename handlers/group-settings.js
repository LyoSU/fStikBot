const Composer = require('telegraf/composer')

const composer = new Composer()

async function onlyGroupAdmin (ctx, next) {
  if (!ctx.chat) {
    return
  }

  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') {
    return
  }

  if (!ctx.from || !ctx.from.id) {
    return
  }

  const isAdmin = await ctx.telegram.getChatAdministrators(ctx.chat.id)
    .then((admins) => admins.some((admin) => admin.user.id === ctx.from.id))

  if (!isAdmin) {
    return
  }

  return next()
}

composer.command('group_settings', onlyGroupAdmin, async (ctx) => {
  const type = ctx.message.text.split(' ')[1]
  const rights = ctx.message.text.split(' ')[2]

  if (!type || !rights) {
    return
  }

  const group = await ctx.db.Group.findOne({ telegram_id: ctx.chat.id })

  if (!group) {
    return
  }

  group.settings.rights[type] = rights

  group.updatedAt = new Date()

  await group.save()

  return ctx.replyWithHTML(ctx.i18n.t('callback.group_settings.success'))
})

module.exports = composer
