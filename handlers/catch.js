const fs = require('fs')
const path = require('path')
const util = require('util')
const execFile = util.promisify(require('child_process').execFile)
const errorStackParser = require('error-stack-parser')
const { escapeHTML, isRateLimitError, getRetryAfter } = require('../utils')

// Probe once at module load: is .git available at project root?
// Skip git blame entirely in environments without .git (e.g. Docker deploys)
// to avoid spawning a failing git process on every error.
const PROJECT_ROOT = path.resolve(__dirname, '..')
const HAS_GIT_DIR = (() => {
  try {
    return fs.existsSync(path.join(PROJECT_ROOT, '.git'))
  } catch (e) {
    return false
  }
})()

/**
 * Pick the first stack frame that's inside the project AND not in
 * node_modules — git blame against node_modules always fails with
 * "no such path in HEAD" and spams the logs.
 */
function pickBlameFrame (errorInfo) {
  for (const frame of errorInfo) {
    const file = frame.fileName
    if (!file || typeof file !== 'string') continue
    if (!file.startsWith(PROJECT_ROOT)) continue
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (!frame.lineNumber) continue
    return frame
  }
  return null
}

async function errorLog (error, ctx) {
  const errorInfo = errorStackParser.parse(error)

  let gitBlame
  const frame = HAS_GIT_DIR ? pickBlameFrame(errorInfo) : null

  if (frame) {
    // Silent on failure — any noise here would fire on every caught
    // error in prod and drown out real signals.
    gitBlame = await execFile(
      'git',
      ['blame', '-L', `${frame.lineNumber},${frame.lineNumber}`, '--', frame.fileName],
      { timeout: 2000, cwd: PROJECT_ROOT }
    ).catch(() => null)
  }

  let errorText = `<b>error for ${ctx.updateType}:</b>`
  if (ctx.match) errorText += `\n<code>${ctx.match[0]}</code>`
  if (ctx.from && ctx.from.id) errorText += `\n\nuser: <a href="tg://user?id=${ctx.from.id}">${escapeHTML(ctx.from.first_name)}</a> #user_${ctx.from.id}`
  if (ctx?.session?.chainActions && ctx?.session.chainActions.length > 0) errorText += '\n\n🔗 ' + ctx?.session.chainActions.map(v => `<code>${v}</code>`).join(' ➜ ')

  if (gitBlame && !gitBlame.stderr) {
    const parsedBlame = gitBlame.stdout.match(/^(?<SHA>[0-9a-f]+)\s+\((?<USER>.+)(?<DATE>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}\s+)(?<line>\d+)\) ?(?<code>.*)$/m)

    if (parsedBlame?.groups) {
      errorText += `\n\n<u>${parsedBlame.groups.USER.trim()}</u>`
      errorText += `\n<i>commit:</i> ${parsedBlame.groups.SHA}`
      errorText += `\n\n<code>${parsedBlame.groups.code}</code>`
    }
  }

  errorText += `\n\n\n<code>${escapeHTML(error.stack)}</code>`

  if (error.description && error.description.includes('timeout')) return

  if (!ctx.config) return console.error(errorText)

  await ctx.telegram.sendMessage(ctx.config.logChatId, errorText, {
    parse_mode: 'HTML'
  }).catch((error) => {
    console.error('send log error:', error)
  })

  if (ctx?.chat?.type === 'private') {
    await ctx.replyWithHTML(ctx.i18n.t('error.unknown')).catch(() => {})
  }
}

module.exports = async (error, ctx) => {
  console.error(error)

  // Handle 429 rate limit errors gracefully
  if (isRateLimitError(error)) {
    const retryAfter = getRetryAfter(error)
    console.log(`[RateLimit] 429 error, retry_after: ${retryAfter}s`)

    if (ctx?.chat?.type === 'private') {
      const waitText = retryAfter
        ? ctx.i18n.t('error.rate_limit_seconds', { seconds: retryAfter })
        : ctx.i18n.t('error.rate_limit')
      await ctx.replyWithHTML(waitText).catch(() => {})
    }
    return
  }

  errorLog(error, ctx).catch(e => {
    console.error('errorLog error:', e)
  })
}
