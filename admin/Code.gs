/**
 * TeeenS Analytics — GA4 データ取得用（Google Apps Script）
 * 使い方は https://teeen-s.com/admin/ の「接続設定」を参照。
 * 事前に：サービス（＋）→「Google Analytics Data API」を追加（識別子は AnalyticsData のまま）
 * スクリプト プロパティに KEY（パスワード）を登録する。
 */
var PROPERTY = 'properties/548116048';

function doGet(e) {
  var key = PropertiesService.getScriptProperties().getProperty('KEY');
  var p = (e && e.parameter) || {};
  if (!key || p.key !== key) return json_({ ok: false, error: 'unauthorized' });
  try {
    var days = Math.max(1, Math.min(parseInt(p.days, 10) || 28, 365));
    var cache = CacheService.getScriptCache();
    var ck = 'v1_' + days;
    var hit = cache.get(ck);
    if (hit && !p.fresh) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    var out = JSON.stringify(build_(days));
    try { cache.put(ck, out, 300); } catch (err) {}
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function build_(days) {
  var cur = { startDate: (days - 1) + 'daysAgo', endDate: 'today' };
  var prev = { startDate: (days * 2 - 1) + 'daysAgo', endDate: days + 'daysAgo' };
  var M = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'userEngagementDuration', 'keyEvents'];

  function totals(range) {
    var rows = rep_(range, [], M, 1);
    var m = rows.length ? rows[0].m : M.map(function () { return 0; });
    return { users: m[0], newUsers: m[1], sessions: m[2], views: m[3], engagementSec: m[4], keyEvents: m[5] };
  }

  var daily = rep_(cur, ['date'], ['activeUsers', 'sessions', 'screenPageViews'], 400)
    .map(function (r) { return { date: r.d[0], users: r.m[0], sessions: r.m[1], views: r.m[2] }; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });

  var pages = rep_(cur, ['pagePath', 'pageTitle'], ['screenPageViews', 'activeUsers'], 12, 'screenPageViews')
    .map(function (r) { return { path: r.d[0], title: r.d[1], views: r.m[0], users: r.m[1] }; });

  var channels = rep_(cur, ['sessionDefaultChannelGroup'], ['sessions'], 8, 'sessions')
    .map(function (r) { return { name: r.d[0], value: r.m[0] }; });

  var cities = rep_(cur, ['city'], ['activeUsers'], 8, 'activeUsers')
    .map(function (r) { return { name: r.d[0], value: r.m[0] }; });

  var devices = rep_(cur, ['deviceCategory'], ['activeUsers'], 5, 'activeUsers')
    .map(function (r) { return { name: r.d[0], value: r.m[0] }; });

  var events = rep_(cur, ['eventName'], ['eventCount'], 10, 'eventCount')
    .map(function (r) { return { name: r.d[0], value: r.m[0] }; });

  var realtime = 0;
  try {
    var rt = AnalyticsData.Properties.runRealtimeReport({ metrics: [{ name: 'activeUsers' }] }, PROPERTY);
    realtime = (rt.rows && rt.rows.length) ? Number(rt.rows[0].metricValues[0].value) : 0;
  } catch (err) {}

  return {
    ok: true, days: days, generatedAt: new Date().toISOString(),
    cur: totals(cur), prev: totals(prev),
    daily: daily, pages: pages, channels: channels, cities: cities,
    devices: devices, events: events, realtime: realtime
  };
}

function rep_(range, dims, mets, limit, orderMetric) {
  var req = {
    dateRanges: [range],
    metrics: mets.map(function (n) { return { name: n }; }),
    limit: limit || 100
  };
  if (dims.length) req.dimensions = dims.map(function (n) { return { name: n }; });
  if (orderMetric) req.orderBys = [{ metric: { metricName: orderMetric }, desc: true }];
  var r = AnalyticsData.Properties.runReport(req, PROPERTY);
  return (r.rows || []).map(function (row) {
    return {
      d: (row.dimensionValues || []).map(function (v) { return v.value; }),
      m: (row.metricValues || []).map(function (v) { return Number(v.value); })
    };
  });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
