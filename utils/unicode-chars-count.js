module.exports = (str) => {
  if (typeof str !== 'string') throw new TypeError('Expected a string')

  let count = 0
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i < str.length - 1) {
      // This is a surrogate pair, so we need to skip the next code unit
      i++
    }
    count++
  }
  return count
}
