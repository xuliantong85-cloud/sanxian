// 用访问密码加密公开版网页：public/index.html -> 密码页（lock.html）+ 加密内容
// 加密方式：PBKDF2-SHA256 派生密钥，AES-256-GCM 加密；浏览器端在 lock.html 里解密
// 密码来自环境变量 PAGE_PASSWORD（GitHub 仓库的 Secrets 里设置）
// 没有密码时报错退出，避免把未加密的网页发布出去
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const ITER = 310000;
const pw = process.env.PAGE_PASSWORD || '';
if (!pw) { console.error('没有设置 PAGE_PASSWORD，不发布未加密的网页'); process.exit(1); }

const page = path.join(__dirname, 'public', 'index.html');
const html = fs.readFileSync(page, 'utf8');
if (html.includes("'sanxian-pw'")) { console.error('public/index.html 已经加密过了，请先运行 build.py'); process.exit(1); }

const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(pw, salt, ITER, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
// WebCrypto 的 AES-GCM 要求认证标签接在密文后面
const ct = Buffer.concat([c.update(html, 'utf8'), c.final(), c.getAuthTag()]);
const payload = JSON.stringify({ salt: salt.toString('base64'), iv: iv.toString('base64'), iter: ITER, ct: ct.toString('base64') });

const lock = fs.readFileSync(path.join(__dirname, 'lock.html'), 'utf8');
if (!lock.includes('__PAYLOAD__')) { console.error('lock.html 缺少 __PAYLOAD__'); process.exit(1); }
fs.writeFileSync(page, lock.replace('__PAYLOAD__', () => payload));
console.log('public/index.html 已加密');
