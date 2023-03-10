module.exports = (str, start, end) => {
  if (typeof str !== 'string') throw new TypeError('Expected a string')
  if (typeof start !== 'number') throw new TypeError('Expected a number start')
  if (typeof end !== 'number') throw new TypeError('Expected a number end')

  let startIndex = 0
  let endIndex = str.length
  let count = 0

  // Find the start index based on Unicode code points
  for (let i = 0; i < str.length && count < start; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i < str.length - 1) {
      // This is a surrogate pair, so we need to skip the next code unit
      i++
    }
    count++
    startIndex = i + 1
  }

  count = 0

  // Find the end index based on Unicode code points
  for (let i = startIndex; i < str.length && count < end - start; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i < str.length - 1) {
      // This is a surrogate pair, so we need to skip the next code unit
      i++
    }
    count++
    endIndex = i + 1
  }

  return str.substring(startIndex, endIndex)
}
