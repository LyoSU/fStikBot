module.exports = (ctx, next) => {
  const extraDefault = {
    parse_mode: 'HTML'
  }

  const methods = {
    reply: ctx.reply,
    editMessageText: ctx.editMessageText
  }

  Object.keys(methods).forEach((method) => {
    ctx[method] = (...parm) => {
      let extra = parm[parm.length - 1]

      if (typeof extra === 'object') {
        parm = parm.slice(0, parm.length - 1)
        extra = { ...extraDefault, ...extra }
      } else {
        extra = extraDefault
      }

      return methods[method](...parm, extra)
    }
  })

  return next()
}
