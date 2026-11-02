# 估值看板的数据：每日估值（收盘价、市盈率 TTM、市净率）、分红记录、10 年期国债收益率
# 来源：东方财富数据中心 datacenter-web.eastmoney.com
# 文件格式（英文逗号分隔，日期 yymmdd）：
#   val_<代码>.txt   日期:收盘价:市盈率TTM:市净率
#   div_<代码>.txt   除息日:每股税前现金分红（元）:是否年度末期分红（1/0）
#   bond10y.txt      日期:10 年期国债收益率（%）
# stocks.json 里加一只股票，下次运行会自动拉取它的全部历史
import json, time, urllib.parse, urllib.request
from pathlib import Path

D = Path(__file__).parent
API = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
START = '2018-01-01'


def query(report, columns, flt='', sort='', desc=True, page=1, size=500):
    params = {'reportName': report, 'columns': columns, 'pageSize': size, 'pageNumber': page,
              'sortColumns': sort, 'sortTypes': -1 if desc else 1}
    if flt:
        params['filter'] = flt
    url = API + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.loads(r.read().decode('utf8'))
    if not res.get('success') or not res.get('result'):
        raise RuntimeError(f'{report} 没有返回数据')
    return res['result']


def query_all(report, columns, flt, sort):
    rows, page = [], 1
    while True:
        r = query(report, columns, flt, sort, desc=False, page=page)
        rows += r['data']
        if page >= r['pages']:
            return rows
        page += 1
        time.sleep(0.3)


def ymd(s):
    return s[:10]


def compact(d):
    return d[2:].replace('-', '')


def num(x, nd=4):
    return ('%.*f' % (nd, x)).rstrip('0').rstrip('.')


def load(name):
    """文件 -> {'2026-10-30': [字段...]}"""
    p = D / name
    if not p.exists():
        return {}
    out = {}
    for item in p.read_text().strip().split(','):
        if item:
            k, *v = item.split(':')
            out['20' + k[:2] + '-' + k[2:4] + '-' + k[4:6]] = v
    return out


def save(name, rows):
    (D / name).write_text(','.join(compact(d) + ':' + ':'.join(v) for d, v in sorted(rows.items())) + '\n')


def update_valuation(code, name, keep):
    """keep(date) 判断某天是否已收盘；文件不存在时拉全部历史，否则只拉最近 30 天覆盖"""
    fname = f'val_{code}.txt'
    old = load(fname)
    cols = 'TRADE_DATE,CLOSE_PRICE,PE_TTM,PB_MRQ'
    flt = f'(SECURITY_CODE="{code}")'
    if old:
        data = query('RPT_VALUEANALYSIS_DET', cols, flt, 'TRADE_DATE', size=30)['data']
    else:
        data = query_all('RPT_VALUEANALYSIS_DET', cols, flt, 'TRADE_DATE')
    new = {}
    for x in data:
        d = ymd(x['TRADE_DATE'])
        if d < START or not keep(d) or None in (x['CLOSE_PRICE'], x['PE_TTM'], x['PB_MRQ']):
            continue
        new[d] = [num(x['CLOSE_PRICE'], 3), num(x['PE_TTM']), num(x['PB_MRQ'])]
    if not new:
        return f'{name}估值：没有读到数据，沿用原数据'
    last = max(old) if old else '—'
    old.update(new)
    save(fname, old)
    return f'{name}估值：{last} → {max(old)}（共 {len(old)} 天）'


def update_dividends(code, name):
    cols = 'EX_DIVIDEND_DATE,PRETAX_BONUS_RMB,ASSIGN_PROGRESS,REPORT_DATE'
    data = query('RPT_SHAREBONUS_DET', cols, f'(SECURITY_CODE="{code}")', 'EX_DIVIDEND_DATE', size=100)['data']
    rows = {}
    for x in data:
        ex, amt = x.get('EX_DIVIDEND_DATE'), x.get('PRETAX_BONUS_RMB')
        # 只算已经实施、有除息日的现金分红；PRETAX_BONUS_RMB 是每 10 股派息
        if ex and amt and x.get('ASSIGN_PROGRESS') == '实施分配' and ymd(ex) >= '2016-01-01':
            # 第三个字段：1 = 年度末期分红（报告期 12-31），0 = 中期/季度分红
            final = '1' if (x.get('REPORT_DATE') or '')[5:10] == '12-31' else '0'
            rows[ymd(ex)] = [num(amt / 10), final]
    if not rows:
        return f'{name}分红：没有读到数据，沿用原数据'
    old = load(f'div_{code}.txt')
    save(f'div_{code}.txt', rows)
    added = sorted(set(rows) - set(old))
    return f'{name}分红：{len(rows)} 次' + (f'，新增除息日 {", ".join(added)}' if added and old else '')


def update_bond(keep):
    old = load('bond10y.txt')
    cols = 'SOLAR_DATE,EMM00166469'
    if old:
        data = query('RPTA_WEB_TREASURYYIELD', cols, '', 'SOLAR_DATE', size=30)['data']
    else:
        data = query_all('RPTA_WEB_TREASURYYIELD', cols, f"(SOLAR_DATE>='{START}')", 'SOLAR_DATE')
    new = {ymd(x['SOLAR_DATE']): [num(x['EMM00166469'])] for x in data
           if x.get('EMM00166469') and ymd(x['SOLAR_DATE']) >= START and keep(ymd(x['SOLAR_DATE']))}
    if not new:
        return '10 年期国债：没有读到数据，沿用原数据'
    last = max(old) if old else '—'
    old.update(new)
    save('bond10y.txt', old)
    return f'10 年期国债：{last} → {max(old)}'


def update_all(keep):
    try:
        msgs = [update_bond(keep)]
    except Exception as e:
        msgs = [f'10 年期国债：读取失败（{type(e).__name__}），沿用原数据']
    for s in json.loads((D / 'stocks.json').read_text(encoding='utf8')):
        for fn in (lambda: update_valuation(s['code'], s['name'], keep), lambda: update_dividends(s['code'], s['name'])):
            try:
                msgs.append(fn())
            except Exception as e:
                msgs.append(f'{s["name"]}：读取失败（{type(e).__name__}），沿用原数据')
    return msgs


if __name__ == '__main__':
    print('\n'.join(update_all(lambda d: True)))
