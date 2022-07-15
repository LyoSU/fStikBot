const fs = require('fs')
const path = require('path')
const Markup = require('telegraf/markup')
const I18n = require('telegraf-i18n')
const handleStart = require('./start')

const i18n = new I18n({
  directory: path.resolve(__dirname, '../locales'),
  defaultLanguage: 'ru',
  defaultLanguageOnMissing: true
})

const localseFile = fs.readdirSync('./locales/')

module.exports = async (ctx) => {
  const locales = {}

  localseFile.forEach((fileName) => {
    const localName = fileName.split('.')[0]
    if (localName === 'ru' || i18n.t('ru', 'language_name') !== i18n.t(localName, 'language_name')) {
      locales[localName] = {
        flag: i18n.t(localName, 'language_name')
      }
    }
  })

  if (ctx.updateType === 'callback_query') {
    if (locales[ctx.match[1]]) {
      ctx.answerCbQuery(locales[ctx.match[1]].flag)

      ctx.session.userInfo.locale = ctx.match[1]
      ctx.i18n.locale(ctx.match[1])
      await handleStart(ctx)
    }
  } else {
    const button = []

    Object.keys(locales).map((key) => {
      button.push(Markup.callbackButton(locales[key].flag, `set_language:${key}`))
    })

    ctx.reply('🇺🇸 Choose language\n\nHelp with translation: https://crwd.in/fStikBot', {
      reply_markup: Markup.inlineKeyboard(button, {
        columns: 2
      })
    })
  }
}
