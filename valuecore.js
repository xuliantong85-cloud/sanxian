/* ===== 估值看板的计算（纯函数，不碰 DOM，可用 Node.js 测试） =====
 * 估值温度 0–100：市盈率分位、市净率分位、（1 − 股息率分位）三者的平均。
 *   越低越便宜。分位都以 2018 年以来该股自己的历史为基准。
 * 参考价：把市盈率、市净率、股息率分别放回历史 20% / 50% / 80% 分位，换算成股价后取平均。
 */
const Value = (() => {
  // "yymmdd:a:b:c,..." -> [{d, v:[a,b,c]}]
  function parse(s) {
    return (s || '').split(',').filter(Boolean).map(p => {
      const [k, ...v] = p.split(':');
      return { d: '20' + k.slice(0, 2) + '-' + k.slice(2, 4) + '-' + k.slice(4, 6), v: v.map(Number) };
    }).sort((a, b) => a.d < b.d ? -1 : 1);
  }
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  // 有序数组里 <= v 的比例
  function rank(sorted, v) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= v) lo = m + 1; else hi = m; }
    return sorted.length ? lo / sorted.length : null;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q, a = Math.floor(i), b = Math.ceil(i);
    return sorted[a] + (sorted[b] - sorted[a]) * (i - a);
  }
  const mean = xs => { const a = xs.filter(x => x != null && isFinite(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };

  // 每股年度分红：最近一次"年度末期分红" + 最近一次"中期分红"，各自超过 15 个月未再派发就不算。
  // 不用"过去 365 天"滚动求和：除息日每年前后挪几周，会让窗口里出现两次或零次分红，股息率忽高忽低。
  function annualDps(divs, d) {
    const from = addDays(d, -456);
    let fin = null, mid = null;
    for (const x of divs) {
      if (x.d > d) break;
      if (x.d <= from) continue;
      if (x.fin) fin = x; else mid = x;
    }
    return (fin ? fin.x : 0) + (mid ? mid.x : 0);
  }

  // 合成每日序列：股息率 = 每股年度分红 ÷ 收盘价
  function series(valStr, divStr, bondStr) {
    const val = parse(valStr), bond = parse(bondStr);
    const divs = parse(divStr).map(r => ({ d: r.d, x: r.v[0], fin: r.v.length < 2 || r.v[1] === 1 }));
    let bi = 0, by = null;
    return val.map(r => {
      const [close, pe, pb] = r.v;
      const dps = annualDps(divs, r.d);
      while (bi < bond.length && bond[bi].d <= r.d) { by = bond[bi].v[0]; bi++; }
      const dy = dps / close * 100;
      return { d: r.d, close, pe, pb, dps, dy, bond: by, spread: by == null ? null : dy - by,
        eps: pe > 0 ? close / pe : null, bps: pb > 0 ? close / pb : null };
    });
  }

  const ZONES = [[20, '明显偏低', 'cold2'], [40, '偏低', 'cold'], [60, '合理', 'flat'], [80, '偏高', 'hot'], [101, '明显偏高', 'hot2']];
  const zone = t => { const z = ZONES.find(z => t < z[0]); return { label: z[1], tone: z[2] }; };

  function analyze(rows) {
    const sorted = k => rows.map(r => r[k]).filter(x => x != null && isFinite(x) && (k !== 'pe' || x > 0)).sort((a, b) => a - b);
    const S = { pe: sorted('pe'), pb: sorted('pb'), dy: sorted('dy'), spread: sorted('spread') };
    const Q = k => ({ q20: quantile(S[k], 0.2), q50: quantile(S[k], 0.5), q80: quantile(S[k], 0.8) });
    const qs = { pe: Q('pe'), pb: Q('pb'), dy: Q('dy'), spread: Q('spread') };

    // 每天的估值温度和参考价（以全部历史为基准）
    const temp = r => {
      const parts = [r.pe > 0 ? rank(S.pe, r.pe) : null, rank(S.pb, r.pb), r.dps > 0 ? 1 - rank(S.dy, r.dy) : null];
      const m = mean(parts); return m == null ? null : m * 100;
    };
    // 参考价：便宜端用市盈率/市净率的 20% 分位、股息率的 80% 分位
    const ref = (r, lowQ) => {
      const hiQ = 1 - lowQ, k = lowQ < 0.5 ? 'q20' : lowQ > 0.5 ? 'q80' : 'q50', kd = lowQ < 0.5 ? 'q80' : lowQ > 0.5 ? 'q20' : 'q50';
      return mean([r.eps != null ? r.eps * qs.pe[k] : null, r.bps != null ? r.bps * qs.pb[k] : null,
        r.dps > 0 && qs.dy[kd] > 0 ? r.dps / (qs.dy[kd] / 100) : null]);
    };
    const hist = rows.map(r => ({ d: r.d, close: r.close, temp: temp(r), low: ref(r, 0.2), mid: ref(r, 0.5), high: ref(r, 0.8),
      dy: r.dy, bond: r.bond }));

    const n = rows.length, cur = rows[n - 1], prev = rows[n - 2], h = hist[n - 1];
    const ma = k => { const a = rows.slice(Math.max(0, n - k)).map(r => r.close); return a.reduce((s, x) => s + x, 0) / a.length; };
    const ma250 = ma(250);
    // 一年前的温度，用来看方向
    const yearAgo = hist.filter(x => x.d <= addDays(cur.d, -365)).pop();
    return {
      cur, chg: prev ? (cur.close / prev.close - 1) * 100 : null, temp: h.temp, zone: zone(h.temp),
      tempYearAgo: yearAgo ? yearAgo.temp : null,
      pct: { pe: cur.pe > 0 ? rank(S.pe, cur.pe) : null, pb: rank(S.pb, cur.pb), dy: rank(S.dy, cur.dy), spread: cur.spread == null ? null : rank(S.spread, cur.spread) },
      qs, ref: { low: h.low, mid: h.mid, high: h.high },
      ma250, ma250Dev: (cur.close / ma250 - 1) * 100,
      since: rows[0].d, days: n, hist,
    };
  }

  return { parse, series, analyze, zone, ZONES, rank, quantile };
})();
if (typeof module !== 'undefined') module.exports = Value;
