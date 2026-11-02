// 用访问密码加密 public/ 下的每个网页：原网页 -> 密码页（lock.html）+ 加密内容
// 加密方式：PBKDF2-SHA256 派生密钥，AES-256-GCM 加密；浏览器端在 lock.html 里解密
// 所有网页用同一个密码；勾选"记住密码"后，打开其他网页也会自动解锁
// 密码来自环境变量 PAGE_PASSWORD（GitHub 仓库的 Secrets 里设置）
// 没有密码时报错退出，避免把未加密的网页发布出去
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const ITER = 310000;
const pw = process.env.PAGE_PASSWORD || '';
if (!pw) { console.error('没有设置 PAGE_PASSWORD，不发布未加密的网页'); process.exit(1); }

const lock = fs.readFileSync(path.join(__dirname, 'lock.html'), 'utf8');
if (!lock.includes('__PAYLOAD__')) { console.error('lock.html 缺少 __PAYLOAD__'); process.exit(1); }

const dir = path.join(__dirname, 'public');
const pages = fs.readdirSync(dir).filter(f => f.endsWith('.html'));
if (!pages.length) { console.error('public/ 下没有网页'); process.exit(1); }

for (const name of pages) {
  const page = path.join(dir, name);
  const html = fs.readFileSync(page, 'utf8');
  if (html.includes("'sanxian-pw'")) { console.error(`public/${name} 已经加密过了，请先运行 build.py`); process.exit(1); }

  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pw, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  // WebCrypto 的 AES-GCM 要求认证标签接在密文后面
  const ct = Buffer.concat([c.update(html, 'utf8'), c.final(), c.getAuthTag()]);
  const payload = JSON.stringify({ salt: salt.toString('base64'), iv: iv.toString('base64'), iter: ITER, ct: ct.toString('base64') });

  // 密码页的标题沿用原网页的标题
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  let out = lock.replace('__PAYLOAD__', () => payload);
  if (title) out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`);
  fs.writeFileSync(page, out);
  console.log(`public/${name} 已加密`);
}
