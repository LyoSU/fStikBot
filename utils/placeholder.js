// Bootstrap-placeholder handling.
//
// Every new sticker set must be created with at least one sticker, so the bot
// seeds each set with a throwaway placeholder (see scenes/pack-new.js). That
// placeholder has to be removed once the set holds real content — but Telegram
// refuses to delete the *last* sticker of a set, so removal can only happen
// after a real sticker has been added.
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

// Telegram surfaces the cooldown as parameters.retry_after (seconds).
const getRetryAfter = (error) =>
  error?.parameters?.retry_after ||
  error?.response?.parameters?.retry_after ||
  null

// Remove the placeholder now that a real sticker exists in the set.
//
// Reliability by design:
//   • matched by the stored file_unique_id, never by index — a real sticker can
//     never be deleted by mistake;
//   • only ever attempted when the set has ≥2 stickers — Telegram never sees a
//     "can't delete the last sticker" error (the old blind-timer failure mode);
//   • waits out a 429 cooldown (bounded) before giving up;
//   • best-effort — a failure here never fails the user's sticker add;
//   • self-healing — the marker (stickerSet.placeholderFileUniqueId) is cleared
//     only once the placeholder is truly gone, so any residual failure is
//     retried on the next sticker add.
//
// Returns true when the marker was resolved (deleted or confirmed absent),
// false when it should be retried later.
async function removePlaceholderIfPending (telegram, stickerSet, currentSet) {
  if (!stickerSet.placeholderFileUniqueId) return true
  // Telegram forbids deleting the last sticker — wait until a real one exists.
  if (!currentSet || !currentSet.stickers || currentSet.stickers.length < 2) return false

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
      const canRetry = attempt < MAX_ATTEMPTS && retryAfter
      if (!canRetry) {
        // Keep the marker so the next added sticker retries the removal.
        console.error('[placeholder] cleanup failed, will retry on next add:', error?.description || error?.message || error)
        return false
      }
      await delay(Math.min(retryAfter * 1000, MAX_WAIT_MS))
    }
  }

  return false
}

module.exports = { removePlaceholderIfPending }
