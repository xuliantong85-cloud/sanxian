/* ===== 指标计算与分析（纯函数，不碰 DOM） ===== */
const Core = (() => {
  function parseCompact(s) {
    return s.split(',').filter(Boolean).map(p => {
      const [d, c] = p.split(':');
      return { d: '20' + d.slice(0, 2) + '-' + d.slice(2, 4) + '-' + d.slice(4, 6), c: +c };
    }).filter(r => isFinite(r.c) && r.c > 0);
  }
  function toCompact(rows) {
    return rows.map(r => r.d.slice(2).replace(/-/g, '') + ':' + r.c).join(',');
  }
  // FRED 纯文本数据页：行格式 "2026-10-28\t7743.98"
  function parseFredText(t) {
    const out = [];
    const re = /(\d{4}-\d{2}-\d{2})\s+(\d{3,}\.\d+)/g;
    let m;
    while ((m = re.exec(t))) out.push({ d: m[1], c: +m[2] });
    return out;
  }
  // 东方财富 K 线接口：klines 里每项是 "2026-10-30,3599.02"
  function parseEastmoney(t) {
    const out = [];
    const re = /"(\d{4}-\d{2}-\d{2}),(\d+\.\d+)/g;
    let m;
    while ((m = re.exec(t))) out.push({ d: m[1], c: +m[2] });
    return out;
  }
  // 腾讯行情 K 线接口：day 里每项是 ["2026-10-30","开","收","高","低","量"]
  function parseTencent(t) {
    const out = [];
    const re = /\["(\d{4}-\d{2}-\d{2})","[\d.]+","(\d+(?:\.\d+)?)"/g;
    let m;
    while ((m = re.exec(t))) out.push({ d: m[1], c: +m[2] });
    return out.filter(r => r.c > 0);
  }
  // 新浪前复权因子：[{"d":"2026-07-16", "f":"1.0000"}, ...]，某日的因子是不晚于该日的最近一条
  function parseSinaFq(t) {
    const out = [];
    const re = /"d"\s*:\s*"(\d{4}-\d{2}-\d{2})"\s*,\s*"f"\s*:\s*"(\d+(?:\.\d+)?)"/g;
    let m;
    while ((m = re.exec(t))) out.push({ d: m[1], c: +m[2] });
    return out.filter(r => r.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
  }
  // 去掉单日涨跌超过 maxJump 的异常行（数据源偶尔会把别的代码的行情混进来）
  function dropJumps(rows, maxJump) {
    const out = [];
    rows.forEach(r => { const p = out[out.length - 1]; if (!p || Math.abs(r.c / p.c - 1) <= maxJump) out.push(r); });
    return out;
  }
  // 原始收盘价 ÷ 前复权因子 = 前复权价（按比例复权，涨跌幅不失真）
  function applyFq(rows, fq) {
    if (!fq || !fq.length) return rows;
    let j = 0, f = fq[0].c;
    return rows.map(r => {
      while (j < fq.length && fq[j].d <= r.d) { f = fq[j].c; j++; }
      return { d: r.d, c: r.c / f };
    });
  }
  // EODHD 日线 JSON：[{"date":"2026-10-30",...,"close":7580.07,...}]
  function parseEodhd(t) {
    const out = [];
    const re = /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"[^}]*?"close"\s*:\s*(\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(t))) out.push({ d: m[1], c: +m[2] });
    return out.filter(r => r.c > 0);
  }
  // 以 primary 为准合并，secondary 只补 primary 最后日期之后的行
  function merge(primary, secondary) {
    if (!primary.length) return secondary.slice();
    const map = new Map();
    primary.forEach(r => map.set(r.d, r.c));
    const last = primary[primary.length - 1].d;
    secondary.forEach(r => { if (r.d > last && !map.has(r.d)) map.set(r.d, r.c); });
    return [...map.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([d, c]) => ({ d, c }));
  }

  function sma(c, n) {
    const out = new Array(c.length).fill(null); let s = 0;
    for (let i = 0; i < c.length; i++) {
      s += c[i]; if (i >= n) s -= c[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  function stdev(c, mean, n) {
    const out = new Array(c.length).fill(null);
    for (let i = n - 1; i < c.length; i++) {
      let v = 0; for (let k = i - n + 1; k <= i; k++) v += (c[k] - mean[i]) ** 2;
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }
  function rsi(c, n = 14) {
    const out = new Array(c.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < c.length; i++) {
      const ch = c[i] - c[i - 1], up = Math.max(ch, 0), dn = Math.max(-ch, 0);
      if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
      else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return out;
  }
  // v 在 arr（非空值）中的百分位
  function pctRank(arr, v) {
    const a = arr.filter(x => x != null); if (!a.length) return null;
    return a.filter(x => x <= v).length / a.length;
  }

  function compute(rows) {
    const c = rows.map(r => r.c);
    const ma20 = sma(c, 20), sd20 = stdev(c, ma20, 20);
    const ma50 = sma(c, 50), ma100 = sma(c, 100), ma200 = sma(c, 200);
    const up = ma20.map((m, i) => m == null ? null : m + 2 * sd20[i]);
    const lo = ma20.map((m, i) => m == null ? null : m - 2 * sd20[i]);
    const pb = c.map((x, i) => up[i] == null || up[i] === lo[i] ? null : (x - lo[i]) / (up[i] - lo[i]));
    const bw = ma20.map((m, i) => m == null ? null : (up[i] - lo[i]) / m * 100);
    const r14 = rsi(c, 14);
    const bias = (ma) => c.map((x, i) => ma[i] == null ? null : (x / ma[i] - 1) * 100);
    return { rows, c, ma20, ma50, ma100, ma200, up, lo, pb, bw, rsi: r14,
      b20: bias(ma20), b50: bias(ma50), b200: bias(ma200) };
  }

  const f1 = x => x == null ? '—' : x.toFixed(1);
  const f2 = x => x == null ? '—' : x.toFixed(2);
  const fp = (x, d = 1) => x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d) + '%';
  // 价位：指数取整数，个股等低价品种保留两位小数
  const fi = x => x == null ? '—' : Math.abs(x) < 1000 ? x.toFixed(2) : Math.round(x).toLocaleString('en-US');

  function analyze(ind) {
    const n = ind.c.length, i = n - 1, c = ind.c[i];
    const yr = Math.max(0, n - 252);
    const last = k => ind[k][i];
    const win = (k) => ind[k].slice(yr, n);
    const m = {
      date: ind.rows[i].d, close: c, prev: ind.c[i - 1],
      chg: (c / ind.c[i - 1] - 1) * 100,
      ma20: last('ma20'), ma50: last('ma50'), ma100: last('ma100'), ma200: last('ma200'),
      up: last('up'), lo: last('lo'), pb: last('pb'), bw: last('bw'), rsi: last('rsi'),
      b20: last('b20'), b50: last('b50'), b200: last('b200'),
      bwPct: pctRank(win('bw'), last('bw')),
      b20Pct: pctRank(win('b20'), last('b20')),
      b200Pct: pctRank(win('b200'), last('b200')),
      hi52: Math.max(...ind.c.slice(yr)), lo52: Math.min(...ind.c.slice(yr)),
      ma200Slope: ind.ma200[i - 20] ? (ind.ma200[i] / ind.ma200[i - 20] - 1) * 100 : null,
      rsiPrev5: ind.rsi[i - 5],
    };
    m.offHigh = (c / m.hi52 - 1) * 100;

    // 最近 15 天内是否有收口（带宽处于一年最低 15%）
    let recentSqueeze = false;
    for (let k = Math.max(yr, n - 15); k < n - 1; k++) if (pctRank(win('bw'), ind.bw[k]) <= 0.15) recentSqueeze = true;
    m.recentSqueeze = recentSqueeze;

    // 背离：近 10 日创 60 日新高/新低，但 RSI 没有同步
    const look = 60, recent = 10;
    const seg = ind.c.slice(n - look), rseg = ind.rsi.slice(n - look);
    const hiIdx = seg.indexOf(Math.max(...seg)), loIdx = seg.indexOf(Math.min(...seg));
    m.divergence = null;
    if (hiIdx >= look - recent) {
      const prevMax = Math.max(...rseg.slice(0, look - recent).filter(x => x != null));
      if (rseg[hiIdx] < prevMax - 5) m.divergence = 'bear';
    }
    if (loIdx >= look - recent) {
      const prevMin = Math.min(...rseg.slice(0, look - recent).filter(x => x != null));
      if (rseg[loIdx] > prevMin + 5) m.divergence = 'bull';
    }

    // 均线穿越：最近一次收盘跌破/站上 100 日、200 日均线
    function lastCross(k) {
      const above = c > ind[k][i];
      let j = i; while (j > 0 && ind[k][j] != null && (ind.c[j] > ind[k][j]) === above) j--;
      return { above, days: i - j };
    }
    m.x100 = lastCross('ma100'); m.x200 = lastCross('ma200');

    // ---- 三个周期的判断 ----
    const longUp = c > m.ma200, slopeUp = m.ma200Slope > 0;
    let longTerm, longScore;
    if (longUp && slopeUp) { longScore = 2; longTerm = `收盘高于 200 日均线 ${fp(m.b200)}，且 200 日均线仍在上行（近 20 日 ${fp(m.ma200Slope, 2)}），长期上升趋势完好。`; }
    else if (longUp) { longScore = 1; longTerm = `收盘仍在 200 日均线上方 ${fp(m.b200)}，但 200 日均线已经走平或下拐，长期趋势动能在减弱。`; }
    else if (!slopeUp) { longScore = -2; longTerm = `收盘低于 200 日均线 ${fp(m.b200)}，且 200 日均线向下，长期趋势转空。`; }
    else { longScore = -1; longTerm = `收盘跌到 200 日均线下方 ${fp(m.b200)}，但 200 日均线还在上行，这是长期趋势受到考验的位置，需要看能否在几天内收回。`; }

    let midScore = c > m.ma50 ? 1 : -1;
    let midTerm = c > m.ma50
      ? `价格在 50 日均线上方（偏离 ${fp(m.b50)}），中期节奏偏多。`
      : `价格在 50 日均线下方（偏离 ${fp(m.b50)}），中期节奏转弱。`;
    if (!m.x100.above && m.x100.days <= 5) midTerm += `这是 ${m.x100.days} 个交易日前才跌破的 100 日均线（${fi(m.ma100)}），属于新出现的走弱信号。`;
    else if (m.x100.above && m.x100.days <= 5) midTerm += `${m.x100.days} 个交易日前重新站上 100 日均线（${fi(m.ma100)}）。`;
    else midTerm += c > m.ma100 ? `100 日均线（${fi(m.ma100)}）在下方提供支撑。` : `100 日均线（${fi(m.ma100)}）已变成上方压力。`;

    let shortScore = 0, rsiState, rsiTone;
    if (m.rsi >= 70) { rsiState = '超买'; rsiTone = 'hot'; shortScore = 1; }
    else if (m.rsi >= 55) { rsiState = '偏强'; rsiTone = 'up'; shortScore = 1; }
    else if (m.rsi > 45) { rsiState = '中性'; rsiTone = 'flat'; shortScore = 0; }
    else if (m.rsi > 30) { rsiState = '偏弱'; rsiTone = 'down'; shortScore = -1; }
    else { rsiState = '超卖'; rsiTone = 'cold'; shortScore = -1; }

    let bbState, bbTone;
    if (m.pb > 1) { bbState = '突破上轨'; bbTone = 'hot'; }
    else if (m.pb >= 0.8) { bbState = '贴近上轨'; bbTone = 'up'; }
    else if (m.pb > 0.2) { bbState = '轨道中部'; bbTone = 'flat'; }
    else if (m.pb >= 0) { bbState = '贴近下轨'; bbTone = 'down'; }
    else { bbState = '跌破下轨'; bbTone = 'cold'; }
    if (m.pb < 0.5) shortScore -= 1; else shortScore += 1;

    let biasState, biasTone;
    if (m.b20Pct >= 0.9) { biasState = '正偏离偏大'; biasTone = 'hot'; }
    else if (m.b20Pct <= 0.1) { biasState = '负偏离偏大'; biasTone = 'cold'; }
    else if (m.b20 >= 0) { biasState = '均线上方'; biasTone = 'up'; }
    else { biasState = '均线下方'; biasTone = 'down'; }

    let shortTerm = `RSI(14) 为 ${f1(m.rsi)}（${rsiState}），5 个交易日前是 ${f1(m.rsiPrev5)}；`
      + `布林线 %B 为 ${f2(m.pb)}（${bbState}），带宽 ${f2(m.bw)}%，处在近一年 ${Math.round(m.bwPct * 100)}% 分位；`
      + `相对 20 日均线偏离 ${fp(m.b20, 2)}，处在近一年 ${Math.round(m.b20Pct * 100)}% 分位。`;
    if (m.recentSqueeze && (m.pb > 1 || m.pb < 0)) shortTerm += `近期布林带刚经历收口，随后价格${m.pb > 1 ? '向上' : '向下'}突破轨道，通常意味着一段方向性波动刚开始，而不是马上反转。`;
    else if (m.bwPct <= 0.15) shortTerm += '布林带正处于收口状态，大波动可能临近，但方向未定。';
    if (c <= m.lo52 * 1.001) shortTerm += '收盘创近一年新低。';
    else if (c >= m.hi52 * 0.999) shortTerm += '收盘创近一年新高。';
    if (m.divergence === 'bear') shortTerm += '近期价格创 60 日新高，RSI 却没有跟上，出现顶背离。';
    if (m.divergence === 'bull') shortTerm += '近期价格创 60 日新低，RSI 却没有创新低，出现底背离。';

    // ---- 总判断 ----
    let verdict, tone;
    if (longScore > 0) {
      if (shortScore <= -1) { verdict = '长期上升趋势中的短期回调'; tone = 'caution'; }
      else if (m.rsi >= 70 || m.pb > 1) { verdict = '趋势向上，短线过热'; tone = 'hot'; }
      else { verdict = '多头趋势延续'; tone = 'up'; }
    } else {
      if (shortScore >= 1) { verdict = '弱势中的反弹'; tone = 'caution'; }
      else { verdict = '空头占优'; tone = 'down'; }
    }
    if (m.rsi <= 30) verdict += '，RSI 进入超卖区';
    else if (m.pb < 0) verdict += '，价格跌破布林下轨';
    else if (m.rsi >= 70) verdict += '，RSI 进入超买区';
    else if (m.pb > 1) verdict += '，价格突破布林上轨';

    // ---- 关键价位 ----
    const levels = [
      { k: '布林上轨', v: m.up }, { k: '20 日均线（中轨）', v: m.ma20 }, { k: '布林下轨', v: m.lo },
      { k: '50 日均线', v: m.ma50 }, { k: '100 日均线', v: m.ma100 }, { k: '200 日均线', v: m.ma200 },
      { k: '52 周最高', v: m.hi52 }, { k: '52 周最低', v: m.lo52 },
    ].filter(x => x.v != null).map(x => ({ ...x, dist: (x.v / c - 1) * 100 })).sort((a, b) => b.v - a.v);
    const above = levels.filter(x => x.v > c * 1.0005 && x.k !== '布林下轨' && x.k !== '52 周最低').sort((a, b) => a.v - b.v);
    const below = levels.filter(x => x.v < c * 0.9995 && x.k !== '布林上轨' && x.k !== '52 周最高').sort((a, b) => b.v - a.v);

    // ---- 情景 ----
    const r1 = above[0], r2 = above[1], s1 = below[0], s2 = below[1];
    const scenarios = [];
    if (r1) scenarios.push({ tone: 'up', title: '转强条件',
      text: `${m.pb < 0 ? `先收回布林下轨（${fi(m.lo)}）之内，再` : ''}收盘重新站上${r1.k}（${fi(r1.v)}，距今 ${fp(r1.dist)}），同时 RSI 回到 50 以上，说明这轮${shortScore < 0 ? (longScore < 0 ? '下跌' : '回调') : '整理'}大概率告一段落${r2 ? `，再上方看${r2.k}（${fi(r2.v)}）` : ''}。` });
    if (s1) scenarios.push({ tone: 'down', title: '转弱条件',
      text: `收盘跌破${s1.k}（${fi(s1.v)}，距今 ${fp(s1.dist)}）且几天内收不回来${s2 ? `，下一个参考位是${s2.k}（${fi(s2.v)}，${fp(s2.dist)}）` : ''}。${m.ma200 < c ? '跌破 200 日均线会把短期回调升级为趋势问题。' : ''}` });
    if (m.rsi <= 35 || m.pb < 0.05) scenarios.push({ tone: 'flat', title: m.rsi <= 35 ? '超卖反弹' : '下轨附近的反弹',
      text: `${m.rsi <= 35 ? 'RSI 已接近超卖区' : `价格已在布林下轨附近（%B ${f2(m.pb)}），但 RSI ${f1(m.rsi)} 还没到超卖`}。${longScore > 0 ? '长期趋势向上时，这类位置常出现技术性反弹' : '长期趋势向下时，超卖后的反弹往往只是反抽，力度和持续性都偏弱'}；超卖也可以持续，最好等 RSI 拐头向上、价格回到下轨之内再确认。` });
    if (m.rsi >= 68 || m.pb > 0.95) scenarios.push({ tone: 'flat', title: m.rsi >= 68 ? '过热回落' : '上轨附近的回落',
      text: `${m.rsi >= 68 ? 'RSI 已接近超买区' : `价格已在布林上轨附近（%B ${f2(m.pb)}），但 RSI ${f1(m.rsi)} 还没到超买`}。${longScore > 0 ? '上升趋势中超买可以维持一段时间，' : '下跌趋势里的超买往往是反弹接近尾声的信号，'}但追高的风险收益比变差，留意 RSI 跌回 70 以下或出现顶背离。` });

    // ---- 历史相似情形 ----
    const fw = [5, 20], hits = [];
    for (let k = 200; k < n - 20; k++) {
      if (ind.rsi[k] == null || ind.pb[k] == null || ind.ma200[k] == null) continue;
      if ((ind.c[k] > ind.ma200[k]) !== (c > m.ma200)) continue;
      if (Math.abs(ind.rsi[k] - m.rsi) > 5) continue;
      if (Math.abs(ind.pb[k] - m.pb) > 0.2) continue;
      hits.push(k);
    }
    const stat = h => {
      if (!hits.length) return null;
      const rs = hits.map(k => (ind.c[k + h] / ind.c[k] - 1) * 100).sort((a, b) => a - b);
      return { median: rs[Math.floor(rs.length / 2)], win: rs.filter(x => x > 0).length / rs.length,
        p10: rs[Math.floor(rs.length * 0.1)], p90: rs[Math.floor(rs.length * 0.9)] };
    };
    // 把相邻命中日合并成"事件"，避免同一段行情重复计数
    let episodes = 0; hits.forEach((k, j) => { if (j === 0 || k - hits[j - 1] > 5) episodes++; });
    const analog = { n: hits.length, episodes, span: [ind.rows[Math.min(200, n - 1)].d, ind.rows[Math.max(0, n - 21)].d],
      f5: stat(5), f20: stat(20) };

    return { m, verdict, tone, longTerm, midTerm, shortTerm, longScore, midScore, shortScore,
      rsiState, rsiTone, bbState, bbTone, biasState, biasTone, levels, scenarios, analog };
  }

  return { parseCompact, toCompact, parseFredText, parseEastmoney, parseTencent, parseSinaFq, applyFq, dropJumps, parseEodhd, merge, compute, analyze, fmt: { f1, f2, fp, fi } };
})();
if (typeof module !== 'undefined') module.exports = Core;
