var testConfig = require('../../config/tests/relationship-v1')
var purchase = require('../../services/purchase')
var testSession = require('../../services/testSession')
var progressStore = require('../../storage/progress')
var format = require('../../utils/format')

Page({
  data: {
    title: '',
    subtitle: '',
    priceText: '',
    purchased: false,
    hasProgress: false,
    answered: 0,
    total: 0,
    primaryText: '开始测评'
  },

  onShow: function () {
    this.refreshState()
  },

  refreshState: function () {
    var config = testConfig
    var purchased = purchase.hasPurchase(config.id)
    var session = testSession.getSession(config.id)
    var answered = progressStore.answeredCount(session)
    var total = (config.questions || []).length
    var hasProgress = answered > 0 && answered < total

    var primaryText = '开始测评'
    if (hasProgress) {
      primaryText = '继续测评'
    }

    this.setData({
      title: config.title,
      subtitle: config.subtitle,
      priceText: format.formatPrice(config.priceFen),
      purchased: purchased,
      hasProgress: hasProgress,
      answered: answered,
      total: total,
      primaryText: primaryText
    })
  },

  onPrimaryTap: function () {
    var config = testConfig
    if (!purchase.hasPurchase(config.id)) {
      xhs.navigateTo({ url: '/pages/payment/payment' })
      return
    }

    if (this.data.hasProgress) {
      xhs.navigateTo({ url: '/pages/test/test' })
      return
    }

    testSession.startFresh(config.id)
    xhs.navigateTo({ url: '/pages/test/test' })
  },

  onRestartTap: function () {
    var that = this
    xhs.showModal({
      title: '确定重新开始吗？',
      content: '当前测评进度将被清除。',
      success: function (res) {
        if (!res.confirm) return
        testSession.startFresh(testConfig.id)
        that.refreshState()
        xhs.navigateTo({ url: '/pages/test/test' })
      }
    })
  }
})
