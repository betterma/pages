var entitlement = require('../storage/entitlement')

/**
 * V1：模拟购买。日后替换为小红书支付即可。
 */
function mockPurchase(testId, priceFen) {
  return entitlement.markPurchased(testId, {
    amountFen: priceFen || 0,
    orderId: 'mock_' + Date.now()
  })
}

function hasPurchase(testId) {
  return entitlement.isPurchased(testId)
}

function getPurchase(testId) {
  return entitlement.getEntitlement(testId)
}

module.exports = {
  mockPurchase: mockPurchase,
  hasPurchase: hasPurchase,
  getPurchase: getPurchase
}
