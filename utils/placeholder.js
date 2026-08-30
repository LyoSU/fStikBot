// Bootstrap-placeholder handling.
//
// Every new sticker set must be created with at least one sticker, so the bot
// seeds each set with a throwaway placeholder (see scenes/pack-new.js). That
// placeholder has to be removed once the set holds real content.
//
// Telegram *does* allow deleting the last sticker (verified — it just leaves a
// 0-sticker set, which stays valid and can be re-populated). We still defer
// removal until a real sticker exists, on purpose: it keeps the pack from ever
// being momentarily empty, so we never depend on how long Telegram keeps an
// empty set around.
//
// This lives in its own module (telegram injected, no DB import) so the logic
// is unit-testable in isolation.
//
// DB footprint: placeholderFileUniqueId is transient. Setting it to undefined
// and saving issues a Mongo $unset, so the field physically exists only on a
// freshly-created set that hasn't received its first real sticker yet — it
// disappears from the document the moment the placeholder is removed.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// How hard to try deleting the placeholder within a single call. Telegram's
// patched callApi already retries short 429s (≤5s); this outer loop additionally
// waits out a longer per-user cooldown, which is exactly the case that used to
// leave placeholders behind ("не видаляло бо тг кидав помилку"). Kept modest so
// a normal sticker-add handler is never parked for long — anything past this is
// caught by the self-healing retry on the next add.
const MAX_ATTEMPTS = 3
const MAX_WAIT_MS = 30 * 1000
const TRANSIENT_RETRY_MS = 1000

// Telegram surfaces the cooldown as parameters.retry_after (seconds).
const getRetryAfter = (error) =>
  error?.parameters?.retry_after ||
  error?.response?.parameters?.retry_after ||
  null

// Besides a 429 cooldown, a quick in-call retry is worth it for what's plainly
// transient: a Telegram 5xx, or a bare network failure (no Telegram description
// at all — e.g. a socket error). A 400 is deterministic; retrying can't help.
const isTransientError = (error) => {
  const code = error?.code ?? error?.response?.error_code
  if (typeof code === 'number' && code >= 500) return true
  return !(error?.description || error?.response?.description)
}

// A doc hydrated through a projection that omits placeholderFileUniqueId is
// indistinguishable from one whose placeholder is already removed — exactly
// that confusion once disabled cleanup on the whole session-doc add path
// (user-update.js selects a fixed field list). When the field wasn't selected,
// re-read just the marker through the doc's own model, so this module still
// needs no direct DB import. Full docs and plain test objects pass through.
const withMarkerLoaded = async (stickerSet) => {
  if (typeof stickerSet.isSelected !== 'function') return stickerSet
  if (stickerSet.isSelected('placeholderFileUniqueId')) return stickerSet
  if (typeof stickerSet.constructor?.findById !== 'function') return stickerSet
  const fresh = await stickerSet.constructor
    .findById(stickerSet._id)
    .select('placeholderFileUniqueId')
    .catch(() => null)
  return fresh || stickerSet
}

// Remove the placeholder now that a real sticker exists in the set.
//
// Reliability by design:
//   • matched by the stored file_unique_id, never by index — a real sticker can
//     never be deleted by mistake;
//   • only ever attempted when the set has ≥2 stickers — so removing the
//     placeholder never leaves the pack momentarily empty. The exception is
//     options.allowEmpty (used when the user deletes their last real sticker):
//     a lone placeholder is then removed too — a 0-sticker set is valid
//     (verified live) and truer than a pack whose only content is a throwaway;
//   • waits out a 429 cooldown (bounded) before giving up;
//   • best-effort — a failure here never fails the user's sticker add;
//   • self-healing — the marker (stickerSet.placeholderFileUniqueId) is cleared
//     only once the placeholder is truly gone, so any residual failure is
//     retried on the next sticker add.
//
// Returns true when the marker was resolved (deleted or confirmed absent),
// false when it should be retried later.
async function removePlaceholderIfPending (telegram, stickerSet, currentSet, { allowEmpty = false } = {}) {
  stickerSet = await withMarkerLoaded(stickerSet)
  if (!stickerSet.placeholderFileUniqueId) return true
  if (!currentSet || !currentSet.stickers) return false
  // Wait until a real sticker exists so removal never leaves the pack empty —
  // unless the caller explicitly allows emptying the set (allowEmpty).
  if (currentSet.stickers.length < 2 && !allowEmpty) return false

  const placeholder = currentSet.stickers.find(
    (s) => s.file_unique_id === stickerSet.placeholderFileUniqueId
  )

  if (!placeholder) {
    // Not in the set anymore (e.g. removed manually) — stop tracking it.
    stickerSet.placeholderFileUniqueId = undefined // → Mongo $unset on save
    await stickerSet.save().catch(() => {})
    return true
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await telegram.callApi('deleteStickerFromSet', { sticker: placeholder.file_id })
      stickerSet.placeholderFileUniqueId = undefined
      await stickerSet.save().catch(() => {})
      return true
    } catch (error) {
      const retryAfter = getRetryAfter(error)
      const canRetry = attempt < MAX_ATTEMPTS && (retryAfter || isTransientError(error))
      if (!canRetry) {
        // Keep the marker so the next added sticker retries the removal.
        console.error('[placeholder] cleanup failed, will retry on next add:', error?.description || error?.message || error)
        return false
      }
      await delay(retryAfter ? Math.min(retryAfter * 1000, MAX_WAIT_MS) : TRANSIENT_RETRY_MS)
    }
  }

  return false
}

module.exports = { removePlaceholderIfPending }
