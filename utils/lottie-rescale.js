// Retarget a TGS (gzipped Lottie JSON) between Telegram canvases.
//
// Telegram pins the Lottie canvas per sticker type: 512×512 for regular
// animated stickers, 100×100 for custom emoji. A TGS copied across pack types
// is otherwise rejected outright. Lottie is vector, so the retarget is
// lossless: we wrap every original layer in ONE precomp layer and scale that
// layer by target/source. Nothing inside the animation is touched (no
// per-layer transform math, no keyframe rewriting), which is what keeps this
// safe for arbitrary artwork.
//
// Other Telegram TGS rules (≤3 s, 30/60 fps, no expressions/images/…) are
// inherited from the source, which already passed them in its original pack.
// The one thing that CAN change is the byte size, so the 64 KB cap is checked
// after re-packing.

const zlib = require('zlib')

const MAX_TGS_BYTES = 64 * 1024
const WRAPPER_ASSET_PREFIX = 'fstik_canvas_'

const ERR_INVALID = () => ({ error: { i18nKey: 'sticker.add.error.invalid_animated' } })
const ERR_TOO_BIG = () => ({ error: { i18nKey: 'sticker.add.error.animated_too_big' } })

function parseTgs (buffer) {
  try {
    const json = JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null
    if (!Number.isFinite(json.w) || !Number.isFinite(json.h) || !Array.isArray(json.layers)) return null
    return json
  } catch (_) {
    return null
  }
}

/**
 * @param {Buffer} buffer gzipped Lottie
 * @returns {{ w: number, h: number } | null}
 */
function readTgsSize (buffer) {
  const json = parseTgs(buffer)
  return json ? { w: json.w, h: json.h } : null
}

function uniqueAssetId (assets) {
  const taken = new Set(assets.map((a) => a && a.id))
  let i = 0
  let id = `${WRAPPER_ASSET_PREFIX}${i}`
  while (taken.has(id)) id = `${WRAPPER_ASSET_PREFIX}${++i}`
  return id
}

/**
 * @param {Buffer} buffer      gzipped Lottie (TGS)
 * @param {number} targetSize  512 for stickers, 100 for custom emoji
 * @returns {{ buffer: Buffer } | { error: { i18nKey: string } }}
 *   Returns the SAME buffer instance when the canvas already matches.
 */
function rescaleTgs (buffer, targetSize) {
  const src = parseTgs(buffer)
  if (!src) return ERR_INVALID()

  if (src.w === targetSize && src.h === targetSize) return { buffer }

  const assets = Array.isArray(src.assets) ? src.assets : []
  const refId = uniqueAssetId(assets)
  const scale = (targetSize / Math.max(src.w, src.h)) * 100

  // Precomp layer (ty 0) covering the whole target canvas: anchored at the
  // source centre, positioned at the target centre, scaled uniformly.
  const wrapper = {
    ddd: 0,
    ind: 1,
    ty: 0,
    nm: 'canvas',
    refId,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: { a: 0, k: [targetSize / 2, targetSize / 2, 0] },
      a: { a: 0, k: [src.w / 2, src.h / 2, 0] },
      s: { a: 0, k: [scale, scale, 100] }
    },
    ao: 0,
    w: src.w,
    h: src.h,
    ip: src.ip,
    op: src.op,
    st: 0,
    bm: 0
  }

  const out = {
    ...src,
    w: targetSize,
    h: targetSize,
    assets: [...assets, { id: refId, layers: src.layers }],
    layers: [wrapper]
  }

  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 })
  if (packed.length > MAX_TGS_BYTES) return ERR_TOO_BIG()

  return { buffer: packed }
}

module.exports = { rescaleTgs, readTgsSize, MAX_TGS_BYTES }
