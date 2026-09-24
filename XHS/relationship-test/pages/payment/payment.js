var testConfig = require('../../config/tests/relationship-v1')
var purchase = require('../../services/purchase')
var testSession = require('../../services/testSession')
var format = require('../../utils/format')

Page({
  data: {
    title: '',
    priceText: ''
  },

  onLoad: function () {
    this.setData({
      title: testConfig.title,
      priceText: format.formatPrice(testConfig.priceFen)
    })
  },

  onMockPay: function () {
    purchase.mockPurchase(testConfig.id, testConfig.priceFen)
    testSession.startFresh(testConfig.id)
    xhs.redirectTo({
      url: '/pages/test/test'
    })
  }
})
