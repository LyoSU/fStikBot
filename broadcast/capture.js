// Map Telegram message types → Bot API send method + payload extractor.
//
// Why this exists (vs. `telegraf/core/replicators`): the bundled replicators
// run text/captions through `formatHTML(text, entities)` and set
// `parse_mode: 'HTML'`. That round-trip silently drops any entity type the
// HTML serializer doesn't know about — custom_emoji, blockquote,
// expandable_blockquote, spoiler, and anything Telegram adds later. By
// passing `entities` / `caption_entities` straight through and omitting
// `parse_mode`, Bot API applies the original entity array verbatim.
//
// Adding support for a new message type = one entry below.

const TYPES = {
  text: {
    method: 'sendMessage',
    capture: (m) => ({
      text: m.text,
      entities: m.entities,
      link_preview_options: m.link_preview_options
    })
  },
  photo: {
    method: 'sendPhoto',
    capture: (m) => ({
      photo: m.photo[m.photo.length - 1].file_id,
      caption: m.caption,
      caption_entities: m.caption_entities,
      has_spoiler: m.has_media_spoiler,
      show_caption_above_media: m.show_caption_above_media
    })
  },
  video: {
    method: 'sendVideo',
    capture: (m) => ({
      video: m.video.file_id,
      caption: m.caption,
      caption_entities: m.caption_entities,
      duration: m.video.duration,
      width: m.video.width,
      height: m.video.height,
      supports_streaming: m.video.supports_streaming || undefined,
      has_spoiler: m.has_media_spoiler,
      show_caption_above_media: m.show_caption_above_media
    })
  },
  animation: {
    method: 'sendAnimation',
    capture: (m) => ({
      animation: m.animation.file_id,
      caption: m.caption,
      caption_entities: m.caption_entities,
      duration: m.animation.duration,
      width: m.animation.width,
      height: m.animation.height,
      has_spoiler: m.has_media_spoiler,
      show_caption_above_media: m.show_caption_above_media
    })
  },
  audio: {
    method: 'sendAudio',
    capture: (m) => ({
      audio: m.audio.file_id,
      caption: m.caption,
      caption_entities: m.caption_entities,
      duration: m.audio.duration,
      performer: m.audio.performer,
      title: m.audio.title
    })
  },
  voice: {
    method: 'sendVoice',
    capture: (m) => ({
      voice: m.voice.file_id,
      caption: m.caption,
      caption_entities: m.caption_entities,
      duration: m.voice.duration
    })
  },
  document: {
    method: 'sendDocument',
    capture: (m) => ({
      document: m.document.file_id,
      caption: m.caption,
      caption_entities: m.caption_entities,
      disable_content_type_detection: m.document.disable_content_type_detection
    })
  },
  sticker: {
    method: 'sendSticker',
    capture: (m) => ({
      sticker: m.sticker.file_id,
      emoji: m.sticker.emoji
    })
  },
  video_note: {
    method: 'sendVideoNote',
    capture: (m) => ({
      video_note: m.video_note.file_id,
      duration: m.video_note.duration,
      length: m.video_note.length
    })
  },
  contact: {
    method: 'sendContact',
    capture: (m) => ({
      phone_number: m.contact.phone_number,
      first_name: m.contact.first_name,
      last_name: m.contact.last_name,
      vcard: m.contact.vcard
    })
  },
  location: {
    method: 'sendLocation',
    capture: (m) => ({
      latitude: m.location.latitude,
      longitude: m.location.longitude,
      horizontal_accuracy: m.location.horizontal_accuracy,
      live_period: m.location.live_period,
      heading: m.location.heading,
      proximity_alert_radius: m.location.proximity_alert_radius
    })
  },
  venue: {
    method: 'sendVenue',
    capture: (m) => ({
      latitude: m.venue.location.latitude,
      longitude: m.venue.location.longitude,
      title: m.venue.title,
      address: m.venue.address,
      foursquare_id: m.venue.foursquare_id,
      foursquare_type: m.venue.foursquare_type,
      google_place_id: m.venue.google_place_id,
      google_place_type: m.venue.google_place_type
    })
  },
  poll: {
    method: 'sendPoll',
    capture: (m) => ({
      question: m.poll.question,
      question_entities: m.poll.question_entities,
      options: (m.poll.options || []).map((o) => ({
        text: o.text,
        text_entities: o.text_entities
      })),
      is_anonymous: m.poll.is_anonymous,
      type: m.poll.type,
      allows_multiple_answers: m.poll.allows_multiple_answers,
      correct_option_id: m.poll.correct_option_id,
      explanation: m.poll.explanation,
      explanation_entities: m.poll.explanation_entities,
      open_period: m.poll.open_period,
      close_date: m.poll.close_date
    })
  },
  dice: {
    method: 'sendDice',
    capture: (m) => ({ emoji: m.dice.emoji })
  }
}

const detectType = (message) => {
  if (!message) return null
  return Object.keys(TYPES).find((type) => message[type] !== undefined) || null
}

// Drop undefined-valued keys so the wire payload stays minimal and we don't
// send `caption: undefined` (which Bot API treats as the literal string).
const stripUndefined = (obj) => {
  const out = {}
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) out[k] = obj[k]
  }
  return out
}

const captureMessage = (message) => {
  const type = detectType(message)
  if (!type) return null
  return {
    type,
    data: stripUndefined(TYPES[type].capture(message)),
    replyMarkup: message.reply_markup || null
  }
}

const buildSendCall = (broadcast, chatId) => {
  const { type, data, replyMarkup } = broadcast.message
  const entry = TYPES[type]
  if (!entry) throw new Error(`Unsupported message type: ${type}`)
  const payload = { ...data, chat_id: chatId }
  if (replyMarkup) payload.reply_markup = replyMarkup
  return { method: entry.method, payload }
}

module.exports = { detectType, captureMessage, buildSendCall, TYPES }
