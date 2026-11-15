'use strict';
// Хранилища M HUB: key-value store (mc_main_store_key.json) и именованные конфиги files/config/<name>.json.
// Формы ответов повторяют оригинальный main-процесс (сняты в VM).
const fs = require('node:fs');
const path = require('node:path');

class JsonFile {
  constructor(file, seed) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file) && seed && fs.existsSync(seed)) fs.copyFileSync(seed, file);
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
    this._timer = null;
  }
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 200);
  }
  flush() {
    clearTimeout(this._timer);
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

class Store {
  constructor(dir, seedDir) {
    this.kv = new JsonFile(path.join(dir, 'mc_main_store_key.json'), path.join(seedDir, 'store.json'));
    this.dir = dir; this.seedDir = seedDir;
    this.configs = new Map();
    this.watchers = new Map(); // listenerId -> webContents
    this.nextWatch = 1;
  }
  // --- key-value ---
  get(key, def = null) { return { success: true, value: key in this.kv.data ? this.kv.data[key] : def }; }
  set(key, value) {
    const old = this.kv.data[key];
    this.kv.data[key] = value; this.kv.save();
    this._emit(key, value, old);
    return { success: true, value };
  }
  has(key) { return { success: true, exists: key in this.kv.data }; }
  delete(key) {
    const old = this.kv.data[key];
    const had = key in this.kv.data;
    delete this.kv.data[key]; this.kv.save();
    if (had) this._emit(key, undefined, old);
    return { success: true, deleted: had };
  }
  clear() {
    const old = this.kv.data, keys = Object.keys(old);
    this.kv.data = {}; this.kv.save();
    keys.forEach(k => this._emit(k, undefined, old[k]));
    return { success: true, clearedKeys: keys };
  }
  all() { return { ...this.kv.data }; }
  watch(wc) { const id = `store-${this.nextWatch++}`; this.watchers.set(id, wc); return { success: true, listenerId: id }; }
  unwatch(id) { this.watchers.delete(id); return { success: true }; }
  // Событие storeChange: {listenerId, changeData:{key,value,oldValue}} — отдельно для каждого слушателя
  _emit(key, value, oldValue) {
    for (const [id, wc] of this.watchers) {
      if (wc.isDestroyed()) { this.watchers.delete(id); continue; }
      wc.send('storeChange', { listenerId: id, changeData: { key, value, oldValue } });
    }
  }
  // --- конфиги ---
  config(name) {
    if (!this.configs.has(name)) {
      this.configs.set(name, new JsonFile(path.join(this.dir, `${name}.json`), path.join(this.seedDir, `${name}.json`)));
    }
    return this.configs.get(name);
  }
  getConfig(name) { return this.config(name).data; }
  setConfig(name, data) {
    const c = this.config(name);
    if (data && typeof data === 'object' && !Array.isArray(data)) c.data = { ...c.data, ...data };
    else c.data = data;
    c.save();
    return c.data;
  }
  flushAll() { this.kv.flush(); for (const c of this.configs.values()) c.flush(); }
}

module.exports = { Store, JsonFile };
