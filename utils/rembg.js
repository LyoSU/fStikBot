const got = require('got')

function rembg (url) {
  const params = new URLSearchParams({
    url,
    model: 'isnet-general-use'
  })

  return got(`${process.env.REMBG_URL}/?${params.toString()}`, {
    responseType: 'buffer'
  })
}

module.exports = rembg
