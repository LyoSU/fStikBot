const got = require('got')

function rembg (url) {
  const params = new URLSearchParams({
    url,
    model: 'silueta'
  })

  return got(`${process.env.REMBG_URL}/?${params.toString()}`, {
    responseType: 'buffer'
  })
}

module.exports = rembg
