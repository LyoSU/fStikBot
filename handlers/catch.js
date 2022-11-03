const util = require('util')
const exec = util.promisify(require('child_process').exec)
const errorStackParser = require('error-stack-parser')

const escapeHTML = (str) => str.replace(/[&<>'"]/g,
  tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag)
)

async function errorLog (error, ctx) {
  const errorInfo = errorStackParser.parse(error)

  let gitBlame

  for (const ei of errorInfo) {
    if (!gitBlame) gitBlame = await exec(`git blame -L ${ei.lineNumber},${ei.lineNumber} -- ${ei.fileName}`).catch(() => {})
  }

  let errorText = `<b>error for ${ctx.updateType}:</b>`
  if (ctx.match) errorText += `\n<code>${ctx.match[0]}</code>`
  if (ctx.from && ctx.from.id) errorText += `\n\nuser: <a href="tg://user?id=${ctx.from.id}">${escapeHTML(ctx.from.first_name)}</a> #user_${ctx.from.id}`
  if (ctx?.session?.chainActions && ctx?.session.chainActions.length > 0) errorText += '\n\n🔗 ' + ctx?.session.chainActions.map(v => `<code>${v}</code>`).join(' ➜ ')

  if (gitBlame && !gitBlame.stderr) {
    const parsedBlame = gitBlame.stdout.match(/^(?<SHA>[0-9a-f]+)\s+\((?<USER>.+)(?<DATE>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}\s+)(?<line>\d+)\) ?(?<code>.*)$/m)

    errorText += `\n\n<u>${parsedBlame.groups.USER.trim()}</u>`
    errorText += `\n<i>commit:</i> ${parsedBlame.groups.SHA}`
    errorText += `\n\n<code>${parsedBlame.groups.code}</code>`
  }

  errorText += `\n\n\n<code>${escapeHTML(error.stack)}</code>`

  if (error.description && error.description.includes('timeout')) return

  if (!ctx.config) return console.error(errorText)

  await ctx.telegram.sendMessage(ctx.config.logChatId, errorText, {
    parse_mode: 'HTML'
  }).catch((error) => {
    console.error('send log error:', error)
  })

  await ctx.replyWithHTML(ctx.i18n.t('error.unknown')).catch(() => {})
}

module.exports = async (error, ctx) => {
  console.error(error)

  errorLog(error, ctx).catch(e => {
    console.error('errorLog error:', e)
  })
}
