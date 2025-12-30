/**
 * Decode Telegram sticker set ID to extract owner user ID and set number
 *
 * Two formats:
 * 1. Standard (32-bit user IDs): upper 32 bits = owner_id, lower 32 bits = set_number
 * 2. Extended (64-bit user IDs): when byte 24-31 = 0xff:
 *    - owner_id = upper32 + 0x180000000
 *    - set_number = lower 4 bits
 *
 * @param {BigInt} u64 - The sticker set ID as BigInt
 * @returns {{ ownerId: number, setId: number }}
 */
function decodeStickerSetId (u64) {
  const upper32 = u64 >> 32n
  const lower32 = u64 & 0xffffffffn
  const byte24 = (u64 >> 24n) & 0xffn

  let ownerId, setId

  if (byte24 === 0xffn) {
    // Extended format for 64-bit user IDs
    // When byte24 = 0xff, bit31 of lower32 is always 1
    // So: owner = upper32 + 0x100000000 + 0x80000000 = upper32 + 0x180000000
    ownerId = upper32 + 0x180000000n
    setId = lower32 & 0xfn // lower 4 bits
  } else {
    // Standard format for 32-bit user IDs
    ownerId = upper32
    setId = lower32
  }

  return {
    ownerId: Number(ownerId),
    setId: Number(setId)
  }
}

module.exports = decodeStickerSetId
