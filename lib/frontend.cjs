'use strict';
// Загрузка фронтенда производителя с его CDN в локальный кеш пользователя (в репозитории его нет).
// Версия закреплена списком frontend/manifest.json (путь, размер, sha256). Несовпадение хеша означает, что
// производитель обновил файл: он всё равно сохраняется (интерфейс обычно совместим), но пишется предупреждение.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function missing(root, manifest) {
  return manifest.files.filter(f => {
    try { return fs.statSync(path.join(root, f.path)).size === 0; } catch { return true; }
  });
}

// fetchFn(url) -> Promise<Buffer>; onProgress(done, total, file)
async function ensure(root, manifest, fetchFn, { onProgress = () => {}, log = () => {}, concurrency = 6 } = {}) {
  const todo = missing(root, manifest);
  let done = 0, failed = [], changed = [];
  const queue = todo.slice();
  const worker = async () => {
    for (let f; (f = queue.shift());) {
      try {
        const buf = await fetchFn('https://' + f.path);
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        if (sha !== f.sha256) changed.push(f.path);
        const out = path.join(root, f.path);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out + '.part', buf); fs.renameSync(out + '.part', out);
      } catch (e) { failed.push(f.path); log('frontend: не скачан', f.path, e.message); }
      onProgress(++done, todo.length, f.path);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  if (changed.length) log('frontend: файлы отличаются от закреплённой версии', changed.length, changed.slice(0, 5));
  return { total: todo.length, failed, changed };
}

module.exports = { ensure, missing };
