# 每日更新三份数据快照，然后重新生成网页（build.py）
# 快照里已有约 10 年历史，这里只在后面补上新交易日：
#   沪深300、恒生科技：腾讯行情日 K 线，读不到时改用东方财富
#   标普500：FRED 不允许脚本访问，改用 EODHD
#            需要环境变量 EODHD_KEY；没有密钥时跳过标普，只更新另外两个
import json, os, sys, urllib.request
from datetime import date, timedelta
from pathlib import Path

D = Path(__file__).parent
EASTMONEY = ('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={}'
             '&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&end=20500101&lmt=60')
TENCENT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={},day,,,60,qfq'


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


def update_cn(name, tencent, secid, label):
    """在已有历史后面补上新交易日：腾讯为主，东方财富备用"""
    old = load(name)
    last = max(old)
    errs = []
    for src, fn, arg in [('腾讯', from_tencent, tencent), ('东方财富', from_eastmoney, secid)]:
        try:
            fresh = fn(arg)
        except Exception as e:
            errs.append(f'{src} {type(e).__name__}')
            continue
        # 和已有历史重叠的日期对一下，防止数据源口径不同
        common = [d for d in fresh if d in old][-5:]
        if any(abs(fresh[d] / old[d] - 1) > 0.002 for d in common):
            errs.append(f'{src} 数据与已有历史对不上')
            continue
        added = {d: c for d, c in fresh.items() if d > last}
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
            update_cn('snap_csi300.txt', 'sh000300', '1.000300', '沪深300'),
            update_cn('snap_hstech.txt', 'hkHSTECH', '124.HSTECH', '恒生科技')]
    print('\n'.join(msgs))
    import build
    build.main()
    if all('沿用原数据' in m or '跳过' in m for m in msgs):
        sys.exit('三个数据源都没有更新成功')
