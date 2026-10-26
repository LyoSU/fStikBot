// Copy of fstikbot-api utils/studio/fingerprint.js: the same algorithm, so a
// bot line and an API line of the same bug share an `fp`. Keep the two in step.
//
// The same bug, told apart from what changes between two occurrences of it
// (numbers, ids, a build's hashed file names, URLs, line and column), so its
// log lines share one `fp` across users and deploys. And the scrub that keeps
// tokens and initData out of whatever is logged.
const crypto = require('node:crypto')

// Names under which a credential travels, as a query field or a JSON key.
const CREDENTIALS = 'user_token|access_token|refresh_token|id_token|token|session_id|sessionid|session|' +
  'hash|signature|query_id|auth_date|authorization|auth|initData|tgWebAppData|password|secret|api_key|apikey'

// What could identify a user or a session, wherever it ends up in a message
// or a stack: a bot token, an initData or login field, any long opaque run.
const SECRETS = [
  // No \b: in a URL the token follows "/bot" with no boundary before it.
  [/\d{6,}:[\w-]{30,}/g, '<token>'],
  [new RegExp(`\\b(${CREDENTIALS}|user)=[^&\\s"')]+`, 'gi'), '$1=<redacted>'],
  // The same names as keys of a JSON body or a JS object, quoted or quoted
  // inside a string (\"token\":\"...\"): a value of any length goes, short
  // ones too, which the opaque-run rule below would let through.
  [new RegExp(`(\\\\?["'])(${CREDENTIALS})\\1(\\s*:\\s*)\\1(?:(?!\\1)[^\\\\])*`, 'gi'), '$1$2$1$3$1<redacted>'],
  // An Authorization header's value (Bearer, or Telegram's "tma <initData>").
  [/\b(Bearer|tma)\s+[^\s"',;]+/gi, '$1 <redacted>'],
  // Letters and digits mixed: a long identifier or a run of one letter is not a secret.
  [/(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, '<redacted>']
]

function scrub (text) {
  return SECRETS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), String(text ?? ''))
}

// A build's file names carry a content hash (index-AbCd123456.js) and its
// URLs a host and a query; none of it says anything about the bug.
function normalize (text) {
  return String(text ?? '')
    .replace(/https?:\/\/[^/\s)]+/g, '')
    .replace(/\?[^\s):]*/g, '')
    .replace(/([\w.]+)-[\w-]{8,10}(\.(?:m?js|css|wasm))/g, '$1$2')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
}

// The first frame of V8 ("at fn (file:1:2)") and of WebKit and Gecko
// ("fn@file:1:2"); the message lines before it are not frames.
function topFrame (stack) {
  for (const line of String(stack || '').split('\n')) {
    const frame = line.trim()
    if (/^at\s/.test(frame) || /@\S*:\d+:\d+$/.test(frame) || /^\S*@\S+$/.test(frame)) {
      return normalize(frame.replace(/^at\s+/, ''))
    }
  }
  return ''
}

function fingerprint (where, message, stack) {
  return crypto.createHash('sha1')
    .update(`${where}\n${normalize(message)}\n${topFrame(stack)}`)
    .digest('hex')
    .slice(0, 12)
}

module.exports = { scrub, normalize, topFrame, fingerprint }
