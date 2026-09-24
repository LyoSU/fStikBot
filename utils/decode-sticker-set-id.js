/**
 * Decode Telegram sticker set ID to extract owner user ID and set number
 *
 * Two formats:
 * 1. Standard (32-bit user IDs): upper 32 bits = owner_id (unsigned),
 *    lower 32 bits = set_number
 * 2. Extended (64-bit user IDs): when byte 24-31 = 0xff:
 *    - owner_id = upper32 (signed) + 0x180000000, i.e. 2^32..2^33-1
 *    - set_number = lower 4 bits
 *    - dc_id = bits 20-23
 *
 * gram.js gives the id as a signed int64, so owners from 2^31 up come in as
 * negative ids; the standard format reads the upper half unsigned. Either
 * signedness of input decodes the same.
 *
 * @param {BigInt} u64 - The sticker set ID as BigInt
 * @returns {{ ownerId: number, setId: number, dcId: number|null, isExtended: boolean }}
 */
function decodeStickerSetId (u64) {
  const id = BigInt.asIntN(64, BigInt(u64))
  const upper32 = id >> 32n
  const lower32 = id & 0xffffffffn
  const byte24 = (id >> 24n) & 0xffn

  let ownerId; let setId; let dcId = null; let isExtended = false

  if (byte24 === 0xffn) {
    // Extended format for 64-bit user IDs: the signed upper half, shifted
    // by 0x180000000, spans exactly the owners past 32 bits (2^32..2^33-1).
    ownerId = upper32 + 0x180000000n
    setId = lower32 & 0xfn // lower 4 bits
    dcId = Number((lower32 >> 20n) & 0xfn) // bits 20-23
    isExtended = true
  } else {
    // Standard format for 32-bit user IDs
    ownerId = BigInt.asUintN(32, upper32)
    setId = lower32
  }

  return {
    ownerId: Number(ownerId),
    setId: Number(setId),
    dcId,
    isExtended
  }
}

module.exports = decodeStickerSetId
