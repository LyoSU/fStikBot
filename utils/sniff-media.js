// Container detection from magic bytes.
//
// A file that reaches addSticker through a stored "original" (restore, copy,
// re-add of a sticker we made) carries no mime_type, duration or is_video,
// and legacy Telegram file_paths have no extension either. So a GIF/mp4
// original used to fall into the static pipeline and die in sharp.metadata as
// "invalid image" (prod log: `Input buffer contains unsupported image format
// ... First bytes: 0000001c667479706d7034320000000169736f6d` — an `ftypmp42`).
// When nothing else tells us what the bytes are, ask the bytes.

// Enough for the shortest signature we check; out-of-range reads below are
// safe (Buffer.toString clamps, buf[i] is undefined).
const MIN_BYTES = 4

/**
 * @param {Buffer|null|undefined} buf
 * @returns {'mp4'|'webm'|'gif'|'png'|'webp'|'jpeg'|'tgs'|null}
 */
const sniffMedia = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < MIN_BYTES) return null

  // ISO BMFF (mp4 / mov / m4v): 4-byte box size, then 'ftyp'.
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4'
  // Matroska / WebM EBML header.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm'
  if (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a') return 'gif'
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png'
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  // gzip — a .tgs is a gzipped Lottie JSON.
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'tgs'

  return null
}

const VIDEO_CONTAINERS = new Set(['mp4', 'webm', 'gif'])

/** True for anything that has to go through the video converter. */
const isVideoContainer = (buf) => VIDEO_CONTAINERS.has(sniffMedia(buf))

module.exports = { sniffMedia, isVideoContainer }
