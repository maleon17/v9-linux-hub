// Список файлов фронтенда (пути, размеры, sha256) по локальному кешу — для закрепления версии.
// node tools/make-frontend-manifest.mjs <папка-кеша> > frontend/manifest.json
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const root = process.argv[2];
const skip = /^cdn\.mchose\.com\.cn\/(customPage\/(pre|dev|driver-ui_test)\/|OTA\/)/;
const files = [];
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : files.push(f); } };
walk(root);
const out = files.map(f => path.relative(root, f)).filter(r => !skip.test(r) && !r.endsWith('.part')).sort().map(r => {
  const b = fs.readFileSync(path.join(root, r));
  return { path: r, size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') };
});
console.log(JSON.stringify({ version: '1.1.26', entry: 'cdn.mchose.com.cn/customPage/prod/index.html', files: out }, null, 1));
