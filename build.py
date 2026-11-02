# 由模板 page.html、计算逻辑 core.js 和三份数据快照生成两份网页：
#   index.html         claude.ai 版（可刷新数据、保存密钥、Claude 解读）
#   public/index.html  公开版（放在 GitHub Pages，只显示每天更新的快照数据）
import re
from datetime import datetime, timezone
from pathlib import Path

D = Path(__file__).parent

# 公开版没有 claude.ai 运行环境，隐藏刷新、密钥和 Claude 解读
PUBLIC_CSS = ('<style>#refresh,#eod-toggle,#eod-form,#src+.sep,'
              'section.panel:has(#ai-btn){display:none!important}</style>\n')


def main():
    s = (D / 'page.html').read_text(encoding='utf8')
    s = (s.replace('/*__CORE__*/', (D / 'core.js').read_text(encoding='utf8'))
          .replace('__SNAP_CSI__', (D / 'snap_csi300.txt').read_text().strip())
          .replace('__SNAP_HST__', (D / 'snap_hstech.txt').read_text().strip())
          .replace('__SNAP_NDX__', (D / 'snap_ndx.txt').read_text().strip())
          .replace('__SNAP_SPDB_FQ__', (D / 'fq_spdb.txt').read_text().strip())
          .replace('__SNAP_SPDB__', (D / 'snap_spdb.txt').read_text().strip())
          .replace('__SNAP__', (D / 'snap.txt').read_text().strip()))
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    s = re.sub(r'const SNAP_SAVED = "[^"]*";', f'const SNAP_SAVED = "{today}";', s)
    assert '__SNAP' not in s and '/*__CORE__*/' not in s
    (D / 'index.html').write_text(s, encoding='utf8')

    # page.html 本身没有 <html>/<head> 骨架（claude.ai 发布时会自动加），公开版要补上
    p = ('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
         '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
         + s.replace('</style>\n', '</style>\n' + PUBLIC_CSS + '</head>\n<body>\n', 1)
         + '\n</body>\n</html>\n')
    p = (p.replace("'内置快照（FRED + 补充报价）'", "'每日自动更新（FRED / EODHD）'")
          .replace("'内置快照（东方财富）'", "'每日自动更新（腾讯行情 / 东方财富）'")
          .replace("'内置快照（腾讯行情）'", "'每日自动更新（腾讯行情）'"))
    # 公开版在市场切换栏后面加一个去估值看板的链接
    p = p.replace('  </nav>\n', '  </nav>\n  <a href="value.html" style="align-self:flex-end;font-size:13px;margin-top:-12px">分红股估值看板 →</a>\n', 1)
    (D / 'public').mkdir(exist_ok=True)
    (D / 'public' / 'index.html').write_text(p, encoding='utf8')
    build_value(today)
    print('index.html、public/index.html 和 public/value.html 已生成')


def build_value(today):
    """估值看板：value_page.html + valuecore.js + stocks.json 里每只股票的估值/分红 + 国债收益率"""
    import json
    rd = lambda n: (D / n).read_text().strip() if (D / n).exists() else ''
    stocks = [{**s, 'val': rd(f'val_{s["code"]}.txt'), 'div': rd(f'div_{s["code"]}.txt')}
              for s in json.loads((D / 'stocks.json').read_text(encoding='utf8'))]
    stocks = [s for s in stocks if s['val']]
    data = json.dumps({'saved': today, 'bond': rd('bond10y.txt'), 'stocks': stocks}, ensure_ascii=False)
    v = (D / 'value_page.html').read_text(encoding='utf8')
    v = v.replace('/*__VALUECORE__*/', (D / 'valuecore.js').read_text(encoding='utf8')).replace('__VALUE_DATA__', script_safe(data))
    assert '__VALUE_DATA__' not in v and '/*__VALUECORE__*/' not in v
    (D / 'public' / 'value.html').write_text(v, encoding='utf8')


def script_safe(s):
    # 数据嵌进 <script>，防止数据里出现 </script>
    return s.replace('</', '<\\/')


if __name__ == '__main__':
    main()
