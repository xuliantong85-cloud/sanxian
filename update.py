# 每日更新三份数据快照，然后重新生成网页（build.py）
# 快照里已有约 10 年历史，这里只在后面补上新交易日：
#   沪深300、恒生科技：腾讯行情日 K 线，读不到时改用东方财富
#   纳指100：腾讯行情日 K 线，读不到时改用 EODHD（需要 EODHD_KEY）
#   浦发银行：腾讯行情不复权收盘价（新浪备用）；另存新浪前复权因子，生成网页时换算
#   标普500：FRED 不允许脚本访问，改用 EODHD
#            需要环境变量 EODHD_KEY；没有密钥时跳过标普，只更新另外两个
import json, os, re, sys, urllib.request
from datetime import date, timedelta
from pathlib import Path

D = Path(__file__).parent
EASTMONEY = ('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={}'
             '&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&end=20500101&lmt=60')
TENCENT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={},day,,,60,qfq'
TENCENT_RAW = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={},day,,,60,'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf8')


def load(name):
    """快照 -> {'2026-10-30': 3985.5, ...}"""
    out = {}
    for p in (D / name).read_text().strip().split(','):
        d, c = p.split(':')
        out['20' + d[:2] + '-' + d[2:4] + '-' + d[4:6]] = float(c)
    return out


def save(name, rows):
    num = lambda c: ('%.4f' % c).rstrip('0').rstrip('.')
    s = ','.join(d[2:].replace('-', '') + ':' + num(c) for d, c in sorted(rows.items()))
    (D / name).write_text(s + '\n')


def from_tencent(code):
    # 每项是 [日期, 开, 收, 高, 低, 量]
    d = json.loads(get(TENCENT.format(code)))['data'][code]
    return {r[0]: float(r[2]) for r in d['day']}


def from_eastmoney(secid):
    # 东方财富偶尔会临时拒绝连接，只作备用
    klines = json.loads(get(EASTMONEY.format(secid)))['data']['klines']
    return {k.split(',')[0]: float(k.split(',')[1]) for k in klines}


def from_tencent_raw(code):
    # 个股用不复权价（参数末尾不带 qfq）；复权在生成网页时用新浪的因子按比例换算
    d = json.loads(get(TENCENT_RAW.format(code)))['data'][code]
    return {r[0]: float(r[2]) for r in d['day']}


def from_sina_raw(code):
    t = get(f'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol={code}&scale=240&ma=no&datalen=60')
    return {r['day']: float(r['close']) for r in json.loads(t)}


def update_fq(name, code, label):
    """刷新新浪前复权因子（每年分红除息后会多一条）"""
    try:
        t = get(f'https://finance.sina.com.cn/realstock/company/{code}/qfq.js')
        f = sorted(re.findall(r'"d":"(\d{4}-\d{2}-\d{2})",\s*"f":"([\d.]+)"', t))
    except Exception as e:
        return f'{label}复权因子：读取失败（{type(e).__name__}），沿用原因子'
    f = [(d, float(x)) for d, x in f if d >= '2015-01-01' and float(x) > 0]
    if not f:
        return f'{label}复权因子：没有读到数据，沿用原因子'
    old = (D / name).read_text().strip()
    new = ','.join(d[2:].replace('-', '') + ':' + ('%.10f' % x).rstrip('0').rstrip('.') for d, x in f)
    if new == old:
        return f'{label}复权因子：无变化（最近除息日 {f[-1][0]}）'
    (D / name).write_text(new + '\n')
    return f'{label}复权因子：已更新（最近除息日 {f[-1][0]}）'


def from_eodhd(symbol):
    key = os.environ.get('EODHD_KEY', '').strip()
    if not key:
        raise RuntimeError('没有 EODHD_KEY')
    start = (date.today() - timedelta(days=30)).isoformat()
    data = json.loads(get(f'https://eodhd.com/api/eod/{symbol}?api_token={key}&fmt=json&from={start}'))
    if not isinstance(data, list) or not data:
        raise RuntimeError('EODHD 没有返回数据')
    return {r['date']: float(r['close']) for r in data if r.get('close')}


def update_cn(name, tencent, secid, label):
    """沪深300、恒生科技：腾讯为主，东方财富备用"""
    return update_append(name, label, [('腾讯', from_tencent, tencent), ('东方财富', from_eastmoney, secid)])


def update_append(name, label, sources, max_jump=0.2):
    """依次尝试各数据源，在已有历史后面补上新交易日"""
    old = load(name)
    last = max(old)
    errs = []
    for src, fn, arg in sources:
        try:
            fresh = fn(arg)
        except Exception as e:
            # 只记录异常类型和自定义说明，不打印原文，避免带密钥的网址进日志
            errs.append(f'{src} {e}' if isinstance(e, RuntimeError) else f'{src} {type(e).__name__}')
            continue
        # 和已有历史重叠的日期对一下，防止数据源口径不同
        common = [d for d in fresh if d in old][-5:]
        if any(abs(fresh[d] / old[d] - 1) > 0.002 for d in common):
            errs.append(f'{src} 数据与已有历史对不上')
            continue
        added = {d: c for d, c in fresh.items() if d > last}
        # 新数据的单日涨跌超过上限，多半是数据源串了代码（例如腾讯 us.NDX 的当日行情曾是另一只股票）
        prev, jump = old[last], None
        for d in sorted(added):
            if abs(added[d] / prev - 1) > max_jump:
                jump = d
                break
            prev = added[d]
        if jump:
            errs.append(f'{src} {jump} 价格异常（{added[jump]}）')
            continue
        if not added:
            return f'{label}：没有新交易日（最新 {last}，来自{src}）'
        old.update(added)
        save(name, old)
        return f'{label}：{last} → {max(old)}（来自{src}）'
    return f'{label}：读取失败（{"；".join(errs)}），沿用原数据'


def update_spx():
    key = os.environ.get('EODHD_KEY', '').strip()
    if not key:
        return '标普500：没有设置 EODHD_KEY，跳过'
    old = load('snap.txt')
    last = max(old)
    start = (date.fromisoformat(last) - timedelta(days=10)).isoformat()
    try:
        data = json.loads(get(f'https://eodhd.com/api/eod/GSPC.INDX?api_token={key}&fmt=json&from={start}'))
    except Exception as e:
        # 不打印异常原文，避免把带密钥的网址写进日志
        return f'标普500：EODHD 读取失败（{type(e).__name__}），沿用原数据'
    if not isinstance(data, list) or not data:
        return '标普500：EODHD 没有返回数据（可能是密钥无效或额度用完），沿用原数据'
    fresh = {r['date']: float(r['close']) for r in data if r.get('close')}
    added = {d: c for d, c in fresh.items() if d > last}
    if not added:
        return f'标普500：没有新交易日（EODHD 读到 {len(fresh)} 天，最新 {max(fresh)}）'
    old.update(added)
    save('snap.txt', old)
    return f'标普500：{last} → {max(old)}'


if __name__ == '__main__':
    msgs = [update_spx(),
            update_append('snap_ndx.txt', '纳指100', [('腾讯', from_tencent, 'us.NDX'), ('EODHD', from_eodhd, 'NDX.INDX')]),
            update_cn('snap_csi300.txt', 'sh000300', '1.000300', '沪深300'),
            update_cn('snap_hstech.txt', 'hkHSTECH', '124.HSTECH', '恒生科技'),
            # 个股用不复权价，送股除权日可能大跌，放宽到 50%
            update_append('snap_spdb.txt', '浦发银行', [('腾讯', from_tencent_raw, 'sh600000'), ('新浪', from_sina_raw, 'sh600000')], max_jump=0.5)]
    print(update_fq('fq_spdb.txt', 'sh600000', '浦发银行'))
    print('\n'.join(msgs))
    import build
    build.main()
    if all('沿用原数据' in m or '跳过' in m for m in msgs):
        sys.exit('三个数据源都没有更新成功')
