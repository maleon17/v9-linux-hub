'use strict';
// Синтезированные тестовые звуки для проверки 7.1 (свои, без чужих записей).
//   steps  — шаги по бетону: по колонке (4 шага в её направлении) и демо «обход по кругу» вокруг слушателя;
//   cinema — киносцена: по колонке — удар с хвостом; демо — дождь и ветер, гром, пролёт вертолёта, проезд.
// Звук раскладывается по 8 каналам (FL FR FC LFE RL RR SL SR) парным панорамированием с равной мощностью,
// дальше его обрабатывает тракт 7.1 (HRTF), как любую 7.1-дорожку из игры или фильма.
const RATE = 48000;
const CH = { FL: 0, FR: 1, FC: 2, LFE: 3, RL: 4, RR: 5, SL: 6, SR: 7 };
// Кольцо колонок по азимуту (градусы, против часовой стрелки от фронта: +90 — слева)
const RING = [['FC', 0], ['FL', 30], ['SL', 100], ['RL', 145], ['RR', 215], ['SR', 260], ['FR', 330]];
const SPK_AZ = { FL: 30, FR: -30, FC: 0, RL: 145, RR: -145, SL: 100, SR: -100 };
// Колонки в порядке схемы интерфейса: 0 тыл-Л, 1 Л, 2 фронт-Л, 3 центр, 4 фронт-П, 5 П, 6 тыл-П, 7 сабвуфер
const UI_SPK = ['RL', 'SL', 'FL', 'FC', 'FR', 'SR', 'RR', 'LFE'];

// ---------- примитивы ----------
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
function biquad(type, f, q, gainDb = 0) {
  const w = 2 * Math.PI * f / RATE, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q), A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
  else if (type === 'bp') { b0 = a; b1 = 0; b2 = -a; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
  else { b0 = 1 + a * A; b1 = -2 * c; b2 = 1 - a * A; a0 = 1 + a / A; a1 = -2 * c; a2 = 1 - a / A; }   // peak
  const k = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return x => { const y = k[0] * x + k[1] * x1 + k[2] * x2 - k[3] * y1 - k[4] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
const chain = (...fs) => x => fs.reduce((v, f) => f(v), x);

// Панорама по кольцу: азимут (град) -> коэффициенты 8 каналов (равная мощность между соседними колонками)
function pan(az) {
  const g = new Float32Array(8);
  let a = ((az % 360) + 360) % 360;
  for (let i = 0; i < RING.length; i++) {
    const [n0, a0] = RING[i], [n1, a1r] = RING[(i + 1) % RING.length], a1 = a1r <= a0 ? a1r + 360 : a1r;
    const aa = a < a0 ? a + 360 : a;
    if (aa >= a0 && aa <= a1) {
      const t = (aa - a0) / (a1 - a0);
      g[CH[n0]] += Math.cos(t * Math.PI / 2); g[CH[n1]] += Math.sin(t * Math.PI / 2);
      return g;
    }
  }
  g[CH.FC] = 1; return g;
}

class Track {
  constructor(secs) { this.n = Math.round(secs * RATE); this.buf = new Float32Array(this.n * 8); }
  // Моно-источник src(i) длиной len, с позицией azAt(t) (град) и громкостью gainAt(t)
  place(start, len, src, azAt, gainAt = () => 1) {
    const s0 = Math.round(start * RATE);
    let g = pan(azAt(0)), next = 0;
    for (let i = 0; i < len && s0 + i < this.n; i++) {
      if (i >= next) { g = pan(azAt(i / RATE)); next = i + 240; }     // позиция обновляется каждые 5 мс
      const v = src(i) * gainAt(i / RATE), o = (s0 + i) * 8;
      if (s0 + i < 0) continue;
      for (let c = 0; c < 8; c++) if (g[c]) this.buf[o + c] += v * g[c];
    }
  }
  addCh(ch, start, len, src) {
    const s0 = Math.round(start * RATE);
    for (let i = 0; i < len && s0 + i < this.n; i++) this.buf[(s0 + i) * 8 + CH[ch]] += src(i);
  }
  normalize(peakDb = -3) {
    let p = 0; for (const v of this.buf) p = Math.max(p, Math.abs(v));
    const k = p ? 10 ** (peakDb / 20) / p : 1;
    for (let i = 0; i < this.buf.length; i++) this.buf[i] *= k;
    // мягкие края
    const f = 480;
    for (let i = 0; i < f; i++) for (let c = 0; c < 8; c++) { this.buf[i * 8 + c] *= i / f; this.buf[(this.n - 1 - i) * 8 + c] *= i / f; }
    return this;
  }
  wav() {
    const data = Buffer.from(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const fmt = Buffer.alloc(40);
    fmt.writeUInt16LE(0xFFFE, 0); fmt.writeUInt16LE(8, 2); fmt.writeUInt32LE(RATE, 4); fmt.writeUInt32LE(RATE * 32, 8);
    fmt.writeUInt16LE(32, 12); fmt.writeUInt16LE(32, 14); fmt.writeUInt16LE(22, 16); fmt.writeUInt16LE(32, 18);
    fmt.writeUInt32LE(0x63F, 20); Buffer.from('0300000000001000800000aa00389b71', 'hex').copy(fmt, 24);   // float, 7.1
    const hdr = Buffer.alloc(12); hdr.write('RIFF', 0); hdr.writeUInt32LE(4 + 8 + 40 + 8 + data.length, 4); hdr.write('WAVE', 8);
    const ch = (id, len) => { const b = Buffer.alloc(8); b.write(id, 0); b.writeUInt32LE(len, 4); return b; };
    return Buffer.concat([hdr, ch('fmt ', 40), fmt, ch('data', data.length), data]);
  }
}

// ---------- шаг по бетону ----------
// Пятка (глухой удар + хруст), через 35–60 мс носок (тише), иногда песок/мелкие камешки
function footstep(seed, weight = 1) {
  const r = rng(seed), len = Math.round(0.28 * RATE), out = new Float32Array(len);
  const toe = Math.round((0.035 + 0.025 * Math.abs(r())) * RATE);
  for (const [at, amp] of [[0, 1], [toe, 0.55]]) {
    const thump = chain(biquad('lp', 260, 0.7), biquad('peak', 110, 1.2, 6));
    const scuff = chain(biquad('bp', 2200 + 900 * r(), 0.9), biquad('hp', 900, 0.7));
    const crunch = chain(biquad('bp', 4800 + 1500 * r(), 1.4));
    let ph = 0;
    for (let i = 0; at + i < len; i++) {
      const t = i / RATE, n = r();
      const f = 95 - 35 * Math.min(1, t / 0.04);
      ph += 2 * Math.PI * f / RATE;
      const body = (Math.sin(ph) * 0.9 + thump(n) * 2.5) * Math.exp(-t / 0.022);
      const sc = scuff(n) * Math.exp(-t / 0.014) * (t < 0.0015 ? t / 0.0015 : 1) * 1.6;
      const cr = crunch(n) * Math.exp(-t / 0.03) * (0.5 + 0.5 * Math.sin(t * 900 + r())) * 0.5;
      out[at + i] += amp * weight * (body * 0.8 + sc + cr);
    }
  }
  // мелкие камешки
  for (let k = 0; k < 3; k++) {
    const at = Math.round((0.01 + 0.12 * Math.abs(r())) * RATE), bp = biquad('bp', 6000 + 2000 * r(), 3);
    for (let i = 0; i < 400 && at + i < len; i++) out[at + i] += bp(r()) * Math.exp(-i / 60) * 0.25 * weight;
  }
  return out;
}

// Шаги по траектории: azAt(t), темп steps/s
function walk(track, start, secs, rate, azAt, gainAt = () => 1, seed = 1) {
  const n = Math.floor(secs * rate);
  for (let k = 0; k < n; k++) {
    const t = k / rate + 0.012 * rng(seed + k)();
    const st = footstep(seed * 97 + k, k % 2 ? 0.9 : 1);
    track.place(start + t, st.length, i => st[i], () => azAt(t), () => gainAt(t));
  }
}

// ---------- звуки киносцены (тональные, почти без шума) ----------
const env = (t, a, d) => (t < 0 ? 0 : Math.min(1, t / a) * Math.exp(-t / d));
// Ночной ветер: только низы, медленные порывы — фон без шипения
function windBed(track, start, secs, level) {
  for (const c of ['FL', 'FR', 'RL', 'RR', 'SL', 'SR']) {
    const r = rng(c.charCodeAt(0) * 131 + c.charCodeAt(1)), lp = chain(biquad('lp', 220, 0.7), biquad('lp', 260, 0.7));
    let b = 0;
    track.addCh(c, start, Math.round(secs * RATE), i => {
      const t = i / RATE; b = 0.997 * b + 0.04 * r();
      const gust = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.09 * t + c.length * 1.7) * Math.sin(2 * Math.PI * 0.05 * t + 1);
      return Math.min(1, t / 2, (secs - t) / 2) * level * lp(b) * 3 * gust;
    });
  }
}
// Далёкий раскат грома: только низы, без треска
function rumble(track, at, az, level) {
  const r = rng(77), len = Math.round(4 * RATE), lp = chain(biquad('lp', 160, 0.7), biquad('lp', 200, 0.7));
  const src = new Float32Array(len); let b = 0;
  for (let i = 0; i < len; i++) {
    const t = i / RATE; b = 0.998 * b + 0.06 * r();
    src[i] = lp(b) * 4 * Math.min(1, t / 0.3) * Math.exp(-t / 1.1) * (1 + 0.5 * Math.sin(2 * Math.PI * 1.3 * t));
  }
  track.place(at, len, i => src[i] * level, () => az);
  track.addCh('LFE', at, len, i => src[i] * level * 0.8);
}
// Вертолёт: удары лопастей + свист турбины, пролёт по траектории, допплер
function helicopter(track, start, secs, azAt, distAt, level) {
  const r = rng(4242), len = Math.round(secs * RATE), bp = chain(biquad('bp', 420, 0.8), biquad('lp', 1800, 0.7));
  const body = biquad('lp', 160, 0.7); let ph = 0, wp = 0;
  const out = new Float32Array(len), lfe = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / RATE, d = distAt(t), dd = (distAt(t + 0.01) - d) / 0.01, dop = 343 / (343 + dd);
    ph += 17.5 * dop / RATE; wp += 2 * Math.PI * 1150 * dop / RATE;
    const slap = Math.exp(-(ph % 1) / 0.06), n = r();
    const v = bp(n) * slap * 2.2 + body(n) * slap * 4 + Math.sin(wp) * 0.04 + bp(n) * 0.15;
    const g = Math.min(1, 6 / Math.max(d, 1)) * Math.min(1, t / 0.6, (secs - t) / 0.6);
    out[i] = v * g; lfe[i] = body(n) * slap * 3 * g;
  }
  track.place(start, len, i => out[i] * level, azAt);
  track.addCh('LFE', start, len, i => lfe[i] * level * 0.5);
}
// Муха: жужжание (крылья ~210 Гц, богатые гармоники, дрожание высоты и громкости), летает по траектории.
// distAt — расстояние (м): чем ближе, тем громче и ярче.
function fly(track, start, secs, azAt, distAt, level, seed = 5) {
  const r = rng(seed), len = Math.round(secs * RATE), out = new Float32Array(len);
  const tone = biquad('lp', 3200, 0.7), nasal = biquad('peak', 1200, 1.5, 5);
  let ph = 0, jit = 0, amp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / RATE, d = Math.max(0.15, distAt(t)), vr = (distAt(t + 0.01) - distAt(t)) / 0.01, dop = 343 / (343 + vr);
    if (i % 96 === 0) { jit = 0.9 * jit + 0.1 * r(); amp = 0.85 * amp + 0.15 * (0.7 + 0.3 * Math.abs(r())); }
    ph += 2 * Math.PI * 210 * (1 + 0.06 * jit) * dop / RATE;
    const saw = ((ph / (2 * Math.PI)) % 1) * 2 - 1;
    const bright = Math.min(1, 0.6 / d);
    const v = nasal(tone(saw * (0.5 + 0.5 * bright) + Math.sin(ph) * (1 - 0.5 * bright)));
    out[i] = v * amp * Math.min(2.5, 0.5 / d) * Math.min(1, t / 0.15, (secs - t) / 0.15);
  }
  track.place(start, len, i => out[i] * level, azAt);
}
// Низкий удар (финал): спад частоты + сабвуфер
function boom(track, at, level) {
  const len = Math.round(2.5 * RATE), out = new Float32Array(len); let ph = 0;
  for (let i = 0; i < len; i++) { const t = i / RATE; ph += 2 * Math.PI * (70 - 38 * Math.min(1, t / 0.6)) / RATE; out[i] = Math.sin(ph) * env(t, 0.004, 0.55); }
  track.place(at, len, i => out[i] * level * 0.6, () => 0);
  track.addCh('LFE', at, len, i => out[i] * level);
}

// ---------- готовые дорожки ----------
function speakerClip(kind, ui) {
  const name = UI_SPK[ui] || 'FC';
  if (kind === 'cinema') {
    const tr = new Track(2.0);
    if (name === 'LFE') boom(tr, 0, 1);
    else fly(tr, 0, 2.0, t => SPK_AZ[name] + 12 * Math.sin(5 * t), t => 0.7 + 0.25 * Math.sin(3.3 * t), 1, ui + 11);
    return tr.normalize(-6);
  }
  const tr = new Track(2.0);
  if (name === 'LFE') {
    for (let k = 0; k < 4; k++) { const st = footstep(k + 1), lp = chain(biquad('lp', 110, 0.7), biquad('lp', 110, 0.7)); tr.addCh('LFE', k * 0.45, st.length, i => lp(st[i]) * 4); }
  } else walk(tr, 0.02, 1.9, 2.1, () => SPK_AZ[name], () => 1, ui + 3);
  return tr.normalize(-6);
}

function demo(kind) {
  if (kind === 'cinema') {
    // Ветер и далёкий гром; муха кружит вокруг головы, то подлетая к уху, то отлетая; пролёт вертолёта
    // спереди справа над правым плечом назад-влево; муха возвращается сзади; в конце низкий удар
    const T = 22, tr = new Track(T);
    windBed(tr, 0, T, 0.05);
    rumble(tr, 0.6, 60, 0.25);
    fly(tr, 2, 7.5, t => 90 - 75 * t - 25 * Math.sin(1.7 * t), t => 0.45 + 0.35 * Math.sin(1.3 * t) ** 2 + 0.15 * Math.sin(4.1 * t), 0.5, 5);
    helicopter(tr, 8.5, 10, t => -40 - 180 * (t / 10) ** 1.2, t => 3 + 30 * Math.abs(t / 10 - 0.45) ** 1.5, 2.4);
    fly(tr, 15.5, 4, t => -150 + 100 * t, t => 0.9 - 0.15 * t + 0.1 * Math.sin(5 * t), 0.5, 17);
    boom(tr, 19.8, 0.8);
    return tr.normalize(-3);
  }
  // Шаги: два круга вокруг слушателя (против часовой), затем приближение спереди и уход назад
  const T = 16, tr = new Track(T);
  walk(tr, 0.2, 11, 2.4, t => 90 - (t / 5.5) * 360, () => 1, 11);
  walk(tr, 11.6, 4, 2.6, t => (t < 2 ? 0 : 180), t => (t < 2 ? 0.4 + 0.3 * t : 1 - 0.3 * (t - 2)), 23);
  return tr.normalize(-3);
}

module.exports = { speakerClip, demo, UI_SPK, RATE, VERSION: 3 };
