var testConfig = require('../../config/tests/relationship-v1')

Page({
  data: {
    title: '',
    scoreList: []
  },

  onLoad: function () {
    var app = getApp()
    var result = app.globalData.lastResult

    if (!result) {
      xhs.redirectTo({ url: '/pages/home/home' })
      return
    }

    var dimMap = {}
    var dims = testConfig.dimensions || []
    var i
    for (i = 0; i < dims.length; i++) {
      dimMap[dims[i].key] = dims[i].label
    }

    var scores = result.scores || {}
    var keys = Object.keys(scores)
    var scoreList = []
    for (i = 0; i < keys.length; i++) {
      scoreList.push({
        key: keys[i],
        label: dimMap[keys[i]] || keys[i],
        value: scores[keys[i]]
      })
    }

    // 按配置维度顺序排序，仅展示有分的
    var ordered = []
    for (i = 0; i < dims.length; i++) {
      if (scores[dims[i].key] != null) {
        ordered.push({
          key: dims[i].key,
          label: dims[i].label,
          value: scores[dims[i].key]
        })
      }
    }
    if (ordered.length) {
      scoreList = ordered
    }

    this.setData({
      title: result.title || '测评结果',
      scoreList: scoreList
    })

    // 结果仅本次展示，不落本地
    app.globalData.lastResult = null
  },

  onBackHome: function () {
    xhs.reLaunch({ url: '/pages/home/home' })
  }
})
