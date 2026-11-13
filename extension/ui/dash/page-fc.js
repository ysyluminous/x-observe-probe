/* 工作台 · 预测页：粉丝数折线 + 到 5,000 / 10,000 的两条外推（渲染层在 kit.js）。 */
(function () {
  const D = globalThis.XPROBE_DASH;
  D.register('fc', {
    needsDb: false,
    render: function (root, api) {
      api.K.appendSafe(root, api.V.fansForecastLines(api.getState()));
    },
  });
})();
