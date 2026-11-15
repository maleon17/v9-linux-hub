'use strict';
// Preload: мост window.electronAPI между фронтендом и main-процессом.
// Набор методов и имена IPC-каналов — интерфейс фронтенда (lib/api-manifest.json); реализация своя.
// Плюс совместимость WebHID с Windows: HID-стек Windows дополняет выходные/feature-отчёты нулями до длины
// из дескриптора, а Chromium на Linux (hidraw) шлёт ровно переданное — короткие команды гарнитура игнорирует.
const { contextBridge, ipcRenderer, webFrame } = require('electron');
const manifest = require('./api-manifest.json');

webFrame.executeJavaScript(`(() => {
  if (!('hid' in navigator) || window.__hhHidPad) return;
  window.__hhHidPad = true;
  const sizeOf = (dev, kind, id) => {
    let bits = 0;
    for (const c of dev.collections || []) for (const r of c[kind] || []) if (r.reportId === id)
      bits = Math.max(bits, (r.items || []).reduce((s, it) => s + it.reportSize * it.reportCount, 0));
    return bits >> 3;
  };
  const pad = (dev, kind, id, data) => {
    const src = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const n = sizeOf(dev, kind, id);
    if (!n || src.length >= n) return data;
    const out = new Uint8Array(n); out.set(src); return out;
  };
  const P = HIDDevice.prototype, send = P.sendReport, feat = P.sendFeatureReport;
  P.sendReport = function (id, data) { return send.call(this, id, pad(this, 'outputReports', id, data)); };
  P.sendFeatureReport = function (id, data) { return feat.call(this, id, pad(this, 'featureReports', id, data)); };
})()`);

const api = {};
const put = (dotted, fn) => {
  const parts = dotted.split('.'); let o = api;
  while (parts.length > 1) { const p = parts.shift(); o = o[p] = o[p] || {}; }
  o[parts[0]] = fn;
};

for (const [name, ch] of Object.entries(manifest.invoke)) put(name, (...args) => ipcRenderer.invoke(ch, ...args));
put('AudioSDKCall', (method, args = []) => ipcRenderer.invoke('audio-sdk:call', { method, args }));
// Простые подписки без отписки
for (const [name, ch] of Object.entries(manifest.on)) put(name, cb => ipcRenderer.on(ch, (_e, data) => cb(data)));
// Подписки, возвращающие функцию отписки
for (const [name, ch] of Object.entries(manifest.subscribe)) put(name, cb => {
  const l = (_e, data) => cb(data);
  ipcRenderer.on(ch, l);
  return () => ipcRenderer.removeListener(ch, l);
});

// addEventListener(event, key, cb) / removeEventListener(event, key): по одному IPC-слушателю на событие,
// колбэки — по ключам
const listeners = new Map();
api.addEventListener = (event, key, cb) => {
  if (!listeners.has(event)) {
    listeners.set(event, new Map());
    const ch = manifest.events[event];
    if (ch) ipcRenderer.on(ch, (_e, data) => { for (const f of [...listeners.get(event).values()]) f(data); });
  }
  listeners.get(event).set(key, cb);
};
api.removeEventListener = (event, key) => { listeners.get(event)?.delete(key); };

// Компонентный рантайм оригинала (плагины Windows) на Linux не используется — пустой мост
api.componentRuntime = {
  list: () => Promise.resolve([]), checkNow: () => Promise.resolve(true),
  invoke: () => Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED' } }),
  subscribe: () => Promise.resolve(() => {}), onStatusChanged: () => Promise.resolve(() => {}),
};

// Свои функции Linux-версии (пространственный звук, тестовые звуки)
api.linux = {
  get: () => ipcRenderer.invoke('linux:get'),
  set: patch => ipcRenderer.invoke('linux:set', patch),
  hrtfList: () => ipcRenderer.invoke('linux:hrtf-list'),
  testPlay: (kind, speaker) => ipcRenderer.invoke('linux:test-play', kind, speaker),
  testStop: () => ipcRenderer.invoke('linux:test-stop'),
  onChange: cb => { const l = (_e, d) => cb(d); ipcRenderer.on('linux:changed', l); return () => ipcRenderer.removeListener('linux:changed', l); },
};

contextBridge.exposeInMainWorld('electronAPI', api);
