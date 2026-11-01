# 标普·沪深·恒科三线读盘

用布林线、RSI 和偏离度分析标普500、沪深300、恒生科技指数，并给出分周期的后市判断。

## 文件

| 文件 | 内容 |
| --- | --- |
| `index.html` | claude.ai 版网页（可刷新数据、保存 EODHD 密钥、Claude 解读） |
| `public/index.html` | 公开版网页，发布在 GitHub Pages，只显示每天自动更新的数据 |
| `page.html` | 网页模板（界面、图表、刷新与存储逻辑） |
| `core.js` | 指标计算与后市分析逻辑，不依赖浏览器，可用 Node.js 单独测试 |
| `snap.txt` | 标普500 数据快照（FRED 历史 + EODHD 补充，2016-10 起） |
| `snap_csi300.txt` | 沪深300 数据快照（2016-02 起） |
| `snap_hstech.txt` | 恒生科技 数据快照（2016-04 起） |
| `update.py` | 每日更新：在三份快照后面补上新交易日，然后运行 `build.py` |
| `build.py` | 由模板、计算逻辑和快照生成两份网页 |
| `.github/workflows/daily.yml` | GitHub 定时任务：每个交易日运行 `update.py` 并发布到 GitHub Pages |

快照格式：`yymmdd:收盘价`，用英文逗号分隔。

## 每日自动更新

GitHub Actions 在周一至周五 23:00 UTC（北京时间次日 7:00）运行：

1. `update.py` 读取新数据：
   - 沪深300、恒生科技：腾讯行情日 K 线；读不到时改用东方财富。
   - 标普500：EODHD 的 GSPC.INDX（FRED 不允许脚本访问）。需要在仓库的 Settings → Secrets and variables → Actions 里设置 `EODHD_KEY`。
2. 把更新后的快照提交回仓库。
3. 把 `public/` 发布到 GitHub Pages。

也可以在仓库的 Actions 页面选「每日更新」→ Run workflow 手动运行。

## 本地修改后重新生成网页

```
python3 build.py
```

在本地手动更新数据（不设置 `EODHD_KEY` 时只更新沪深300和恒生科技）：

```
EODHD_KEY=你的密钥 python3 update.py
```

## 两个版本的区别

- **claude.ai 版**（`index.html`）：在 Claude 桌面应用里打开，可以用内置浏览器刷新数据、保存 EODHD 密钥、生成 Claude 解读。
- **公开版**（`public/index.html`）：任何人都能打开，不需要登录；没有刷新按钮和 Claude 解读，数据每天由 GitHub 定时任务更新。

本工具基于历史价格计算技术指标，不构成投资建议。
