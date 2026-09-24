var testConfig = require('../../config/tests/relationship-v1')
var purchase = require('../../services/purchase')
var testSession = require('../../services/testSession')

Page({
  data: {
    total: 0,
    currentIndex: 0,
    currentNo: 1,
    question: null,
    selectedKey: '',
    isFirst: true,
    isLast: false,
    canNext: false
  },

  onLoad: function () {
    if (!purchase.hasPurchase(testConfig.id)) {
      xhs.redirectTo({ url: '/pages/payment/payment' })
      return
    }

    var session = testSession.getSession(testConfig.id)
    if (!session) {
      session = testSession.startFresh(testConfig.id)
    }

    this.questions = testConfig.questions || []
    this.answers = Object.assign({}, (session && session.answers) || {})
    var index = (session && session.currentIndex) || 0
    if (index >= this.questions.length) {
      index = Math.max(0, this.questions.length - 1)
    }

    this.setData({ total: this.questions.length })
    this.renderQuestion(index)
  },

  renderQuestion: function (index) {
    var question = this.questions[index]
    if (!question) return

    var selectedKey = this.answers[String(question.id)] || ''
    this.setData({
      currentIndex: index,
      currentNo: index + 1,
      question: question,
      selectedKey: selectedKey,
      isFirst: index === 0,
      isLast: index === this.questions.length - 1,
      canNext: !!selectedKey
    })
  },

  onSelect: function (e) {
    var key = e.currentTarget.dataset.key
    var question = this.data.question
    if (!question || !key) return

    this.answers[String(question.id)] = key
    testSession.saveAnswer(testConfig.id, question.id, key, this.data.currentIndex)
    this.setData({
      selectedKey: key,
      canNext: true
    })
  },

  onPrev: function () {
    if (this.data.isFirst) return
    var nextIndex = this.data.currentIndex - 1
    testSession.updateIndex(testConfig.id, nextIndex)
    this.renderQuestion(nextIndex)
  },

  onNext: function () {
    if (!this.data.canNext) return

    if (this.data.isLast) {
      this.onSubmit()
      return
    }

    var nextIndex = this.data.currentIndex + 1
    testSession.updateIndex(testConfig.id, nextIndex)
    this.renderQuestion(nextIndex)
  },

  onSubmit: function () {
    var result = testSession.submit(testConfig)
    var app = getApp()
    app.globalData.lastResult = result
    xhs.redirectTo({
      url: '/pages/result/result'
    })
  }
})
