'use strict';
// Пространственный звук 7.1 на открытых HRTF.
// Из SOFA-файла (AES69) строятся «пакеты HRIR»: для каждого режима (0 — музыка/игры, 1 — кино) и комнаты (0..2)
// по паре импульсных характеристик (левое/правое ухо) на каждый из 8 каналов. Формат пакета:
//   <папка>/m{режим}_r{комната}_ch{0..7}.wav — стерео float32 48 кГц, каналы в порядке FL FR FC LFE RL RR SL SR.
// Пакет состоит из прямого звука (HRIR направления колонки), ранних отражений прямоугольной комнаты
// (метод мнимых источников, первый порядок, каждое отражение — со своим HRIR) и диффузного хвоста.
// Чтение SOFA — через mysofa2json из libmysofa (она же нужна PipeWire-плагину sofa и есть почти везде).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const https = require('node:https');

const RATE = 48000;
const CH8 = ['FL', 'FR', 'FC', 'LFE', 'RL', 'RR', 'SL', 'SR'];
// Направления колонок (азимут SOFA: 0 — спереди, +90 — слева)
const SPEAKERS = { FL: 30, FR: -30, FC: 0, LFE: 0, RL: 145, RR: -145, SL: 100, SR: -100 };
// Комнаты: размеры (м), коэффициент отражения стен, RT60 (с), отношение прямой/отражённый (дБ), расстояние до колонок (м).
// Подобраны по характеру комнат оригинального движка: 0 — самая «живая», 2 — самая сухая.
const ROOMS = [
  { dim: [6.5, 5.5, 3.2], beta: 0.72, rt: 0.30, dr: 6.5, dist: 2.0 },
  { dim: [4.6, 4.0, 2.8], beta: 0.62, rt: 0.20, dr: 10, dist: 1.6 },
  { dim: [3.6, 3.2, 2.6], beta: 0.52, rt: 0.14, dr: 12, dist: 1.3 },
];
const MODE_DR = [0, -2];          // кино — больше комнаты
const IR_LEN = Math.round(0.26 * RATE);
const TARGET_FC_DB = 2.75;        // уровень FC в полосе 300–3000 Гц на ухо — как у измеренного оригинала

// Встроенный список профилей. Файлы SADIE II (University of York, Apache-2.0) качаются с sofacoustics.org по запросу.
const SOFA_BASE = 'https://sofacoustics.org/data/database/sadie/';
const PROFILES = [
  { id: 'sadie-d1', name: 'KU100 (SADIE II)', file: 'D1_48K_24bit_256tap_FIR_SOFA.sofa', size: 36591729 },
  { id: 'sadie-d2', name: 'KEMAR (SADIE II)', file: 'D2_48K_24bit_256tap_FIR_SOFA.sofa', size: 36591729 },
  // Люди SADIE II (H3–H20). В списке — пятеро самых непохожих (по АЧХ в направлениях колонок, средняя разница
  // между людьми ~4 дБ): H7 — самый «типичный», остальные дальше всего от него и друг от друга.
  // Прочие доступны, если выбраны раньше или указаны вручную.
  ...Array.from({ length: 18 }, (_, k) => k + 3).map(n => ({
    id: `sadie-h${n}`, name: `Human H${n}${n === 7 ? ' — typical' : ''} (SADIE II)`, file: `H${n}_48K_24bit_256tap_FIR_SOFA.sofa`,
    size: n <= 9 ? 11656471 : n <= 15 ? 8753320 : 8755746, hidden: ![7, 19, 14, 5, 9].includes(n), order: [7, 19, 14, 5, 9].indexOf(n),
  })).sort((a, b) => (a.hidden - b.hidden) || (a.order - b.order)),
  // Запасной вариант без сети (идёт с libmysofa): в списке не показывается, включается, если выбранный не скачался
  { id: 'mit-kemar', name: 'KEMAR (MIT)', hidden: true, local: ['/usr/share/libmysofa/MIT_KEMAR_normal_pinna.sofa', '/usr/share/libmysofa/default.sofa'] },
];
const DEFAULT_PROFILE = 'sadie-d2';

// ---------- WAV ----------
function writeStereoF32(file, L, R) {
  const n = L.length, data = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) { data.writeFloatLE(L[i], i * 8); data.writeFloatLE(R[i], i * 8 + 4); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

function resample(x, from) {
  if (from === RATE) return Float32Array.from(x);
  const ratio = RATE / from, n = Math.ceil(x.length * ratio), out = new Float32Array(n), W = 16, fc = Math.min(1, ratio);
  for (let k = 0; k < n; k++) {
    const t = k / ratio, i0 = Math.floor(t); let acc = 0;
    for (let j = i0 - W + 1; j <= i0 + W; j++) {
      if (j < 0 || j >= x.length) continue;
      const d = (t - j) * fc, s = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      acc += x[j] * s * fc * (0.5 + 0.5 * Math.cos(Math.PI * (t - j) / W));
    }
    out[k] = acc;
  }
  return out;
}

// ---------- SOFA ----------
function loadSofa(file) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `mhub-sofa-${process.pid}-${Date.now()}.json`);
    execFile('mysofa2json', ['-s', '-o', tmp, file], { timeout: 120000 }, err => {
      if (err) return reject(new Error('mysofa2json: ' + err.message + ' (нужен пакет libmysofa)'));
      try {
        const j = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        const V = j.Variables, D = j.Dimensions;
        const M = D.M, N = D.N, R = D.R;
        if (R !== 2) throw new Error('ожидалось 2 приёмника (уха)');
        const sp = V.SourcePosition, cart = /cartesian/i.test(sp.Attributes?.Type || '');
        const pos = [];
        for (let m = 0; m < M; m++) {
          let [a, b, c] = sp.Values.slice(m * 3, m * 3 + 3);
          if (cart) { const r = Math.hypot(a, b, c); [a, b, c] = [Math.atan2(b, a) * 180 / Math.PI, Math.asin(c / (r || 1)) * 180 / Math.PI, r]; }
          pos.push([a, b]);
        }
        // Какое ухо левое: приёмник с положительной координатой y
        const rp = V.ReceiverPosition?.Values || [0, 1, 0, 0, -1, 0];
        const leftIdx = rp[1] >= rp[4] ? 0 : 1;
        const rate = V['Data.SamplingRate'].Values[0];
        const ir = V['Data.IR'].Values;
        const get = (m, ear) => {
          const r = ear === 'L' ? leftIdx : 1 - leftIdx, o = (m * 2 + r) * N;
          return resample(ir.slice(o, o + N), rate);
        };
        resolve({ pos, get, name: j.Attributes?.ListenerShortName || path.basename(file), license: j.Attributes?.License || '' });
      } catch (e) { reject(e); } finally { fs.rm(tmp, { force: true }, () => {}); }
    });
  });
}

function nearest(sofa, az, el) {
  const r = Math.PI / 180, ca = Math.cos(el * r);
  const v = [ca * Math.cos(az * r), ca * Math.sin(az * r), Math.sin(el * r)];
  let best = 0, bd = -2;
  sofa.pos.forEach(([a, e], m) => {
    const c = Math.cos(e * r), d = v[0] * c * Math.cos(a * r) + v[1] * c * Math.sin(a * r) + v[2] * Math.sin(e * r);
    if (d > bd) { bd = d; best = m; }
  });
  return best;
}

// ---------- синтез комнаты ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
function onePole(x, a) { const y = new Float32Array(x.length); let z = 0; for (let i = 0; i < x.length; i++) y[i] = z = z + a * (x[i] - z); return y; }
function addAt(dst, src, at, g) { const o = Math.round(at); for (let i = 0; i < src.length && o + i < dst.length; i++) if (o + i >= 0) dst[o + i] += src[i] * g; }
function energy(x) { let s = 0; for (const v of x) s += v * v; return s; }

function buildChannel(sofa, cache, ch, room, mode, seed) {
  const C = 343, az = SPEAKERS[ch], rr = Math.PI / 180;
  const hr = (a, e) => { const m = nearest(sofa, a, e); if (!cache.has(m)) cache.set(m, [sofa.get(m, 'L'), sofa.get(m, 'R')]); return cache.get(m); };
  const L = new Float32Array(IR_LEN), R = new Float32Array(IR_LEN);
  const pre = 24;                                       // запас до прямого звука
  const [dl, dr] = hr(az, 0);
  if (ch === 'LFE') {                                   // бас ненаправленный: единичный импульс в оба уха
    L[pre + 8] = 1; R[pre + 8] = 1;
    return { L, R, lfe: true };
  }
  addAt(L, dl, pre, 1); addAt(R, dr, pre, 1);
  const direct = energy(L) + energy(R);
  // Ранние отражения: мнимые источники 1-го порядка от 6 поверхностей
  const [X, Y, Z] = room.dim, lis = [X / 2, Y / 2, 1.2];
  const src = [lis[0] + room.dist * Math.cos(az * rr), lis[1] + room.dist * Math.sin(az * rr), 1.2];
  const ER_L = new Float32Array(IR_LEN), ER_R = new Float32Array(IR_LEN);
  let firstRef = Infinity;
  const images = [];
  for (let axis = 0; axis < 3; axis++) for (const wall of [0, room.dim[axis]]) {
    const p = src.slice(); p[axis] = 2 * wall - p[axis]; images.push(p);
  }
  // Немного отражений второго порядка (пары стен по горизонтали) — плотнее и естественнее
  for (const [a1, w1] of [[0, 0], [0, X]]) for (const [a2, w2] of [[1, 0], [1, Y]]) {
    const p = src.slice(); p[a1] = 2 * w1 - p[a1]; p[a2] = 2 * w2 - p[a2]; p.order = 2; images.push(p);
  }
  for (const p of images) {
    const d = [p[0] - lis[0], p[1] - lis[1], p[2] - lis[2]], dist = Math.hypot(...d);
    const a = Math.atan2(d[1], d[0]) / rr, e = Math.asin(d[2] / dist) / rr;
    const delay = (dist - room.dist) / C * RATE;
    firstRef = Math.min(firstRef, delay);
    const g = (p.order === 2 ? room.beta * room.beta : room.beta) * room.dist / dist;
    const [hl, hrr] = hr(a, e);
    const lp = p.order === 2 ? 0.45 : 0.65;            // поглощение ВЧ стенами
    addAt(ER_L, onePole(hl, lp), pre + delay, g); addAt(ER_R, onePole(hrr, lp), pre + delay, g);
  }
  // Диффузный хвост: две полосы с разным затуханием (ВЧ гаснут быстрее), независимый шум на уши
  const T_L = new Float32Array(IR_LEN), T_R = new Float32Array(IR_LEN);
  const t0 = Math.round(pre + firstRef + 0.004 * RATE);
  for (const [buf, s] of [[T_L, seed], [T_R, seed + 7919]]) {
    const n = rng(s), w = new Float32Array(IR_LEN);
    for (let i = t0; i < IR_LEN; i++) w[i] = n();
    const lo = onePole(w, 0.12);
    for (let i = t0; i < IR_LEN; i++) {
      const t = (i - t0) / RATE, rise = Math.min(1, (i - t0) / (0.006 * RATE));
      const hi = w[i] - lo[i];
      buf[i] = rise * (lo[i] * 2.2 * Math.exp(-6.91 * t / room.rt) + hi * 0.5 * Math.exp(-6.91 * t / (room.rt * 0.6)));
    }
  }
  // Сведение к нужному отношению прямой/отражённый
  const target = direct / 10 ** ((room.dr + MODE_DR[mode]) / 10);
  const er = energy(ER_L) + energy(ER_R), tl = energy(T_L) + energy(T_R);
  const gE = Math.sqrt(target * 0.55 / (er || 1)), gT = Math.sqrt(target * 0.45 / (tl || 1));
  for (let i = 0; i < IR_LEN; i++) { L[i] += ER_L[i] * gE + T_L[i] * gT; R[i] += ER_R[i] * gE + T_R[i] * gT; }
  // Плавное окончание
  const fade = Math.round(0.03 * RATE);
  for (let i = 0; i < fade; i++) { const k = 0.5 + 0.5 * Math.cos(Math.PI * i / fade); L[IR_LEN - fade + i] *= k; R[IR_LEN - fade + i] *= k; }
  return { L, R };
}

// Уровень в полосе 300–3000 Гц (дБ) — прямым ДПФ по сетке частот
function bandDb(x) {
  let acc = 0, cnt = 0;
  for (let f = 300; f <= 3000; f *= 1.06) {
    let re = 0, im = 0; const w = 2 * Math.PI * f / RATE;
    for (let i = 0; i < Math.min(x.length, 4096); i++) { re += x[i] * Math.cos(w * i); im -= x[i] * Math.sin(w * i); }
    acc += re * re + im * im; cnt++;
  }
  return 10 * Math.log10(acc / cnt);
}

async function buildPack(sofaFile, outDir, log = () => {}) {
  const sofa = await loadSofa(sofaFile);
  fs.mkdirSync(outDir, { recursive: true });
  const cache = new Map();
  for (let mode = 0; mode < 2; mode++) for (let r = 0; r < ROOMS.length; r++) {
    const chans = CH8.map((c, i) => buildChannel(sofa, cache, c, ROOMS[r], mode, 1000 + i * 31 + r * 7));
    // Нормировка всего набора по центральному каналу; LFE — по уровню FC
    const fc = chans[2], fcDb = (bandDb(fc.L) + bandDb(fc.R)) / 2, g = 10 ** ((TARGET_FC_DB - fcDb) / 20);
    chans.forEach((c, i) => {
      const k = c.lfe ? 10 ** (TARGET_FC_DB / 20) : g;
      writeStereoF32(path.join(outDir, `m${mode}_r${r}_ch${i}.wav`), c.L.map(v => v * k), c.R.map(v => v * k));
    });
  }
  fs.writeFileSync(path.join(outDir, 'pack.json'), JSON.stringify({ source: path.basename(sofaFile), subject: sofa.name, license: sofa.license, version: 1 }, null, 1));
  log('HRIR-пакет готов', outDir);
  return outDir;
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const tmp = file + '.part';
    const get = (u, left = 5) => https.get(u, { headers: { 'User-Agent': 'v9-linux-hub' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && left) { res.resume(); return get(new URL(res.headers.location, u).href, left - 1); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(tmp);
      res.pipe(out); out.on('finish', () => out.close(() => { fs.renameSync(tmp, file); resolve(file); }));
      out.on('error', reject);
    }).on('error', reject);
    get(url);
  });
}

class Hrtf {
  // userDir — папка пользователя: сюда можно класть свои *.sofa и готовые пакеты (подпапки с m*_r*_ch*.wav)
  constructor({ dataDir, log }) {
    this.base = path.join(dataDir, 'hrtf');
    this.cacheDir = path.join(os.homedir(), '.cache', 'v9-linux-hub', 'sofa');
    this.packs = path.join(this.base, 'packs');
    this.userDir = path.join(this.base, 'user');
    for (const d of [this.packs, this.userDir, this.cacheDir]) fs.mkdirSync(d, { recursive: true });
    this.log = log || (() => {});
    this.jobs = new Map();
  }
  list(current) {
    const out = PROFILES.filter(p => !p.hidden || (p.id === current && !p.local)).map(p => ({ id: p.id, name: p.name, ready: this.isReady(p.id) }));
    for (const f of fs.readdirSync(this.userDir)) {
      const full = path.join(this.userDir, f);
      if (/\.sofa$/i.test(f)) out.push({ id: 'file:' + f, name: f.replace(/\.sofa$/i, ''), ready: this.isReady('file:' + f) });
      else if (fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'm0_r0_ch0.wav'))) out.push({ id: 'pack:' + f, name: f, ready: true });
    }
    return out;
  }
  packDir(id) {
    if (id.startsWith('pack:')) return path.join(this.userDir, id.slice(5));
    return path.join(this.packs, id.replace(/[^\w.-]/g, '_'));
  }
  isReady(id) { return fs.existsSync(path.join(this.packDir(id), 'm1_r2_ch7.wav')); }
  async sofaFor(id) {
    if (id.startsWith('file:')) return path.join(this.userDir, id.slice(5));
    const p = PROFILES.find(x => x.id === id);
    if (!p) throw new Error('нет профиля ' + id);
    if (p.local) { const f = p.local.find(x => fs.existsSync(x)); if (!f) throw new Error('не найден ' + p.local[0]); return f; }
    const f = path.join(this.cacheDir, p.file);
    if (!fs.existsSync(f) || (p.size && fs.statSync(f).size !== p.size)) { this.log('скачиваю HRTF', p.file); await download(SOFA_BASE + p.file, f); }
    return f;
  }
  // Готовый пакет (генерирует при первом обращении)
  ensure(id) {
    if (this.isReady(id)) return Promise.resolve(this.packDir(id));
    if (!this.jobs.has(id)) {
      const job = (async () => buildPack(await this.sofaFor(id), this.packDir(id), this.log))()
        .finally(() => this.jobs.delete(id));
      this.jobs.set(id, job);
    }
    return this.jobs.get(id);
  }
}

module.exports = { Hrtf, buildPack, PROFILES, DEFAULT_PROFILE, ROOMS };
