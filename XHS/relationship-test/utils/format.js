/**
 * 分转展示价格，如 190 → "¥1.9"
 */
function formatPrice(priceFen) {
  if (typeof priceFen !== 'number') return ''
  const yuan = priceFen / 100
  const text = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(1)
  return '¥' + text
}

module.exports = {
  formatPrice
}
