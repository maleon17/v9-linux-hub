'use strict';
// Звуковой движок: два PipeWire filter-chain (вывод 7.1 и микрофон), запускаемые как дочерние процессы
// `pipewire -c <conf>`. Параметры эффектов подогнаны под измерения Windows-драйвера гарнитуры (dsp/params.json).
// Структурные изменения (7.1 вкл/режим/комната/профиль HRTF, AI-шумодав) пересобирают граф; остальное — на лету.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const audio = require('./audio.cjs');
const { Hrtf, DEFAULT_PROFILE } = require('./hrtf.cjs');
const testsig = require('./testsig.cjs');

const SINK = 'v9hub_surround';
const SOURCE = 'v9hub_mic';
const CH8 = ['FL', 'FR', 'FC', 'LFE', 'RL', 'RR', 'SL', 'SR'];
const LSP = 'http://lsp-plug.in/plugins/lv2/';
// RNNoise (пакет noise-suppression-for-voice): путь зависит от дистрибутива
const RNNOISE = ['/usr/lib/ladspa', '/usr/lib64/ladspa', '/usr/lib/x86_64-linux-gnu/ladspa', '/usr/local/lib/ladspa',
  ...(process.env.LADSPA_PATH || '').split(':').filter(Boolean)]
  .map(d => path.join(d, 'librnnoise_ladspa.so')).find(f => fs.existsSync(f)) || '/usr/lib/ladspa/librnnoise_ladspa.so';
// Magic Voice: Monster, Cartoon, Male Voice, Female Voice -> параметры питч-шифтера v9_voice.so
const VOICES = [
  { semi: -6, tone: -0.6, ring: 28 }, { semi: 7, tone: 0.5, ring: 0 }, { semi: -4, tone: -0.2, ring: 0 }, { semi: 4, tone: 0.3, ring: 0 },
];

const db2lin = db => 10 ** (db / 20);
const lerp = (a, b, t) => a + (b - a) * t;
const run = (cmd, args) => new Promise(res => execFile(cmd, args, { timeout: 5000 }, (e, so) => res(e ? null : so)));

function interp(table, x) {               // table: [[x, {..}], ...] по возрастанию x
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, a] = table[i - 1], [x1, b] = table[i], t = (x - x0) / (x1 - x0);
      return Object.fromEntries(Object.keys(a).map(k => [k, typeof a[k] === 'number' ? lerp(a[k], b[k], t) : a[k]]));
    }
  }
  return table[table.length - 1][1];
}

class Dsp {
  constructor({ dataDir, root, log }) {
    this.dir = path.join(dataDir, 'dsp'); fs.mkdirSync(this.dir, { recursive: true });
    this.root = root; this.log = log || (() => {});
    this.p = JSON.parse(fs.readFileSync(path.join(root, 'dsp', 'params.json'), 'utf8'));
    this.procs = {}; this.struct = {}; this.micMonitor = false; this.loopback = null; this.test = null;
    this.state = null; this.nodeIds = {};
    this.hrtf = new Hrtf({ dataDir, log: this.log });
    this.hrtfId = DEFAULT_PROFILE; this.hrirDir = null;
  }

  // Профиль пространственного звука (id из Hrtf.list()). Пакет готовится заранее, чтобы включение 7.1 было мгновенным.
  setHrtf(id) {
    if (!id || id === this.hrtfId) return;
    this.hrtfId = id;
    this.hrtf.ensure(id).catch(e => this.log('HRTF', id, e.message));
    if (this.state?.XearSurroundEnable && this.hwSink) { this.struct.out = this.structKey(this.state).out; this.restart('out'); }
  }
  async prepHrir() {
    if (!this.state?.XearSurroundEnable) return;
    try { this.hrirDir = await this.hrtf.ensure(this.hrtfId); }
    catch (e) {
      this.log('HRTF недоступен, пробую KEMAR (MIT)', e.message);
      try { this.hrirDir = await this.hrtf.ensure('mit-kemar'); } catch { this.hrirDir = null; }
    }
  }

  // ---------- параметры эффектов из состояния SDK ----------
  // EQ C-Media: Q зависит от |усиления| (proportional-Q), Q(g) = Q12 * (A12/A)^0.83, A = 10^(|g|/40)
  eqBand(i, st) {
    const b = this.p.eq[i], g = st.EQ_GFX ? (st.EQ[i] || 0) : 0;
    const A = 10 ** (Math.max(Math.abs(g), 0.5) / 40);
    return { freq: b.freq, q: Math.min(4, b.q * (2.0 / A) ** 0.83), gain: g };
  }
  brightParams(st) {
    const b = this.p.brightening;
    const tbl = [[0, { freq: b[1].freq, q: b[1].q, gain: b[1].gain * 0.6, lift: b[1].lift * 0.6 }],
      ...[1, 3, 6, 10].map(l => [l, b[l]])];
    const v = interp(tbl, st.AUDIOBRILLIANT_LEVEL);
    return st.AUDIOBRILLIANT_LFX ? v : { freq: v.freq, q: v.q, gain: 0, lift: 0 };
  }
  // Virtual Bass: lowshelf + peaking (подгонка по измерениям, ошибка 0.06–0.2 дБ; форма по срезу, усиление по уровню)
  vbassParams(st) {
    const v = this.p.virtualbass2, F = st.VIRTUALBASS_CutOffFrequency;
    const shape = interp([100, 200, 400].map(f => {
      const x = v[`10_${f}`];
      return [f, { lsr: x.ls_freq / f, lsq: x.ls_q, lsg: x.ls_gain, pkr: x.pk_freq / f, pkq: x.pk_q, pkg: x.pk_gain, lift: x.lift }];
    }), F);
    const k = interp([[0, { k: 0 }], [2, { k: 0.30 }], [5, { k: 0.62 }], [10, { k: 1 }]], st.VIRTUALBASS_Level).k;
    const on = st.VIRTUALBASS_LFX ? 1 : 0;
    return { lsf: shape.lsr * F, lsq: shape.lsq, lsg: shape.lsg * k * on, pkf: shape.pkr * F, pkq: shape.pkq, pkg: shape.pkg * k * on, lift: shape.lift * k * on };
  }
  avParams(st) {
    const lvl = st.ADAPTIVEVOLUME_LEVEL;
    const m1 = st.ADAPTIVEVOLUME_MODE === 1;
    return { enabled: st.ADAPTIVEVOLUME_GFX ? 1 : 0, al: db2lin(m1 ? -42 : -60), cr: m1 ? 8 : 1.75,
      mk: db2lin(m1 ? 6 + 0.18 * lvl : 2 + 0.2 * lvl), at: 10, rt: m1 ? 200 : 400, kn: 1, scm: m1 ? 0 : 1 };   // детектор: Speech — пиковый, Music — RMS
  }

  voiceParams(st) {
    const v = VOICES[st.MagicVoice_Selection | 0] || VOICES[0];
    return st.MAGICVOICE ? { ...v, mix: 1 } : { semi: 0, tone: 0, ring: 0, mix: 0 };
  }

  // ---------- граф вывода ----------
  renderConf(st) {
    const nodes = [], links = [];
    const xearOn = !!st.XearSurroundEnable && !!this.hrirDir;
    for (const c of CH8) nodes.push(`{ type = builtin name = in_${c} label = copy }`);
    if (xearOn) {
      const tag = `m${st.XearSurroundMode | 0}_r${st.XearSurroundRoom | 0}`;
      CH8.forEach((c, i) => {
        for (const [ear, k] of [['L', 0], ['R', 1]]) {
          const f = path.join(this.hrirDir, `${tag}_ch${i}.wav`);
          nodes.push(`{ type = builtin name = x_${c}_${ear} label = convolver config = { filename = "${f}" channel = ${k} gain = 0.9430 } }`);
          links.push(`{ output = "in_${c}:Out" input = "x_${c}_${ear}:In" }`);
        }
      });
      for (const ear of ['L', 'R']) {
        nodes.push(`{ type = builtin name = mix_${ear} label = mixer control = { ${CH8.map((_, i) => `"Gain ${i + 1}" = 1.0`).join(' ')} } }`);
        CH8.forEach((c, i) => links.push(`{ output = "x_${c}_${ear}:Out" input = "mix_${ear}:In ${i + 1}" }`));
      }
    } else {
      const dm = this.p.downmix;
      for (const [ear, k] of [['L', 0], ['R', 1]]) {
        nodes.push(`{ type = builtin name = mix_${ear} label = mixer control = { ${CH8.map((c, i) => `"Gain ${i + 1}" = ${dm[c][k]}`).join(' ')} } }`);
        CH8.forEach((c, i) => links.push(`{ output = "in_${c}:Out" input = "mix_${ear}:In ${i + 1}" }`));
      }
    }
    const br = this.brightParams(st), vb = this.vbassParams(st);
    for (const ear of ['L', 'R']) {
      let prev = `mix_${ear}:Out`;
      this.p.eq.forEach((_, i) => {
        const b = this.eqBand(i, st);
        nodes.push(`{ type = builtin name = eq${i}_${ear} label = bq_peaking control = { "Freq" = ${b.freq} "Q" = ${b.q} "Gain" = ${b.gain} } }`);
        links.push(`{ output = "${prev}" input = "eq${i}_${ear}:In" }`); prev = `eq${i}_${ear}:Out`;
      });
      nodes.push(`{ type = builtin name = br_${ear} label = bq_highshelf control = { "Freq" = ${br.freq} "Q" = ${br.q} "Gain" = ${br.gain} } }`);
      nodes.push(`{ type = builtin name = brg_${ear} label = linear control = { "Mult" = ${db2lin(br.lift)} "Add" = 0 } }`);
      nodes.push(`{ type = builtin name = vb_${ear} label = bq_lowshelf control = { "Freq" = ${vb.lsf} "Q" = ${vb.lsq} "Gain" = ${vb.lsg} } }`);
      nodes.push(`{ type = builtin name = vbp_${ear} label = bq_peaking control = { "Freq" = ${vb.pkf} "Q" = ${vb.pkq} "Gain" = ${vb.pkg} } }`);
      nodes.push(`{ type = builtin name = vbg_${ear} label = linear control = { "Mult" = ${db2lin(vb.lift)} "Add" = 0 } }`);
      links.push(`{ output = "${prev}" input = "br_${ear}:In" }`, `{ output = "br_${ear}:Out" input = "brg_${ear}:In" }`,
        `{ output = "brg_${ear}:Out" input = "vb_${ear}:In" }`, `{ output = "vb_${ear}:Out" input = "vbp_${ear}:In" }`,
        `{ output = "vbp_${ear}:Out" input = "vbg_${ear}:In" }`);
    }
    const av = this.avParams(st);
    nodes.push(`{ type = lv2 name = av plugin = "${LSP}compressor_stereo" control = { enabled = ${av.enabled} cm = 0 al = ${av.al} cr = ${av.cr} mk = ${av.mk} at = ${av.at} rt = ${av.rt} kn = ${av.kn} scm = ${av.scm} } }`);
    nodes.push(`{ type = lv2 name = lim plugin = "${LSP}limiter_stereo" control = { th = ${db2lin(this.p.limiter_db)} lk = 1.0 boost = 0 alr = 0 } }`);
    links.push('{ output = "vbg_L:Out" input = "av:in_l" }', '{ output = "vbg_R:Out" input = "av:in_r" }',
      '{ output = "av:out_l" input = "lim:in_l" }', '{ output = "av:out_r" input = "lim:in_r" }');
    return `context.properties = { log.level = 2 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-rt args = { nice.level = -11 } flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-filter-chain
    args = {
      node.description = "V9 Pro 7.1 Surround"
      media.name = "V9 Pro 7.1 Surround"
      filter.graph = {
        nodes = [ ${nodes.join('\n          ')} ]
        links = [ ${links.join('\n          ')} ]
        inputs = [ ${CH8.map(c => `"in_${c}:In"`).join(' ')} ]
        outputs = [ "lim:out_l" "lim:out_r" ]
      }
      capture.props = { node.name = "${SINK}" media.class = Audio/Sink audio.channels = 8
        audio.position = [ ${CH8.join(' ')} ] device.icon-name = "audio-headset" priority.session = 1000 }
      playback.props = { node.name = "${SINK}_out" node.passive = true audio.channels = 2 audio.position = [ FL FR ]
        stream.dont-remix = true node.dont-reconnect = false target.object = "${this.hwSink || ''}" }
    }
  }
]
`;
  }

  // ---------- граф микрофона ----------
  micConf(st) {
    const nodes = [], links = [];
    let prev = null;
    const add = (n, inp, out) => { nodes.push(n); if (prev) links.push(`{ output = "${prev}" input = "${inp}" }`); prev = out; return inp; };
    const first = add('{ type = builtin name = hp label = bq_highpass control = { "Freq" = 70 "Q" = 0.7 } }', 'hp:In', 'hp:Out');
    if (st.AINR) add(`{ type = ladspa name = nr plugin = "${RNNOISE}" label = noise_suppressor_mono control = { "VAD Threshold (%)" = 50 "VAD Grace Period (ms)" = 200 "Retroactive VAD Grace (ms)" = 0 } }`, 'nr:Input', 'nr:Output');
    const vc = st.VOICECLARITY_LFX;
    add(`{ type = lv2 name = gate plugin = "${LSP}gate_mono" control = { enabled = ${vc && st.VOICECLARITY_NOISESUPP_LEVEL > 0 ? 1 : 0} gr = ${db2lin(-(st.VOICECLARITY_NOISESUPP_LEVEL || 0))} gt = ${db2lin(-50)} at = 5 rt = 150 } }`, 'gate:in', 'gate:out');
    add(`{ type = builtin name = pres label = bq_peaking control = { "Freq" = 3000 "Q" = 0.9 "Gain" = ${vc ? (st.VOICECLARITY_LEVEL || 0) * 0.8 : 0} } }`, 'pres:In', 'pres:Out');
    const mv = this.voiceParams(st);
    add(`{ type = ladspa name = voice plugin = "${path.join(this.root, 'dsp', 'v9_voice.so')}" label = v9_voice control = { "Semitones" = ${mv.semi} "Window (ms)" = 45 "Tone" = ${mv.tone} "Ring (Hz)" = ${mv.ring} "Mix" = ${mv.mix} } }`, 'voice:Input', 'voice:Output');
    add(`{ type = lv2 name = lev plugin = "${LSP}compressor_mono" control = { enabled = ${st.MICVOLUMELEVELING ? 1 : 0} al = ${db2lin(-30)} cr = 4 mk = ${db2lin(6 + (st.MICVOLUMELEVELING_LEVEL || 50) / 10)} at = 5 rt = 200 } }`, 'lev:in', 'lev:out');
    return `context.properties = { log.level = 2 }
context.spa-libs = { audio.convert.* = audioconvert/libspa-audioconvert support.* = support/libspa-support }
context.modules = [
  { name = libpipewire-module-rt args = { nice.level = -11 } flags = [ ifexists nofail ] }
  { name = libpipewire-module-protocol-native }
  { name = libpipewire-module-client-node }
  { name = libpipewire-module-adapter }
  { name = libpipewire-module-filter-chain
    args = {
      node.description = "V9 Pro Microphone"
      media.name = "V9 Pro Microphone"
      filter.graph = { nodes = [ ${nodes.join('\n        ')} ] links = [ ${links.join('\n        ')} ] inputs = [ "${first}" ] outputs = [ "${prev}" ] }
      capture.props = { node.name = "${SOURCE}_in" node.passive = true audio.channels = 1 audio.position = [ MONO ]
        target.object = "${this.hwSource || ''}" stream.dont-remix = true }
      playback.props = { node.name = "${SOURCE}" media.class = Audio/Source audio.channels = 1 audio.position = [ MONO ]
        device.icon-name = "audio-input-microphone" priority.session = 1000 }
    }
  }
]
`;
  }

  structKey(st) {
    return { out: st.XearSurroundEnable ? `x${st.XearSurroundMode | 0}${st.XearSurroundRoom | 0}:${this.hrtfId}` : 'dm', mic: `${st.AINR ? 1 : 0}` };
  }

  async spawnChain(name, conf) {
    this.kill(name);
    this.nodeIds = {};
    const file = path.join(this.dir, `${name}.conf`);
    fs.writeFileSync(file, conf);
    const p = spawn('pipewire', ['-c', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', d => this.log(`[pw:${name}]`, d.toString().trim().slice(0, 400)));
    p.on('exit', code => { if (this.procs[name] === p) { this.procs[name] = null; this.log(`chain ${name} exited`, code); } });
    this.procs[name] = p;
  }
  kill(name) { const p = this.procs[name]; if (p) { this.procs[name] = null; p.kill('SIGTERM'); } }

  // Остатки движка от аварийно завершённого экземпляра (SIGKILL не даёт убрать дочерние процессы)
  async cleanupOrphans() {
    const out = await run('pgrep', ['-af', 'pipewire -c']);
    for (const line of (out || '').split('\n')) {
      const m = /^(\d+)\s+pipewire -c (.*)$/.exec(line.trim());
      if (m && m[2].startsWith(this.dir) && !Object.values(this.procs).some(p => p?.pid === +m[1])) {
        try { process.kill(+m[1], 'SIGTERM'); this.log('убит старый процесс движка', m[1]); } catch {}
      }
    }
  }

  async start(state) {
    this.state = { ...state };
    await this.cleanupOrphans();
    try { this.prepareTestSounds(); } catch (e) { this.log('test sounds', e.message); }
    const hw = await audio.findHw('speaker'), hwm = await audio.findHw('mic');
    this.hwSink = hw?.name; this.hwSource = hwm?.name;
    if (!this.hwSink) { this.log('DSP: гарнитура не найдена, движок ждёт'); this.waitForDevice(); return; }
    this.struct = this.structKey(this.state);
    // Как в Windows: громкостью управляет виртуальное устройство M HUB, сама гарнитура — на 100% без mute
    await run('pactl', ['set-sink-volume', this.hwSink, '100%']);
    await run('pactl', ['set-sink-mute', this.hwSink, '0']);
    await this.prepHrir();
    await this.spawnChain('out', this.renderConf(this.state));
    if (this.hwSource) await this.spawnChain('mic', this.micConf(this.state));
    setTimeout(() => this.makeDefault(), 800);
  }

  waitForDevice() {
    clearInterval(this._wait);
    this._wait = setInterval(async () => {
      if (await audio.findHw('speaker')) { clearInterval(this._wait); this.start(this.state); }
    }, 3000);
  }

  // Изменение состояния SDK -> обновление графа (на лету или пересборка)
  update(state, field) {
    this.state = { ...state };
    if (!this.hwSink) return;
    const k = this.structKey(this.state);
    if (k.out !== this.struct.out || field === '*') { this.struct.out = k.out; return this.restart('out'); }
    if (k.mic !== this.struct.mic) { this.struct.mic = k.mic; return this.restart('mic'); }
    clearTimeout(this._live);
    this._live = setTimeout(() => this.applyLive(field), 30);
  }
  async restart(name) {
    clearTimeout(this._rs?.[name]);
    this._rs = this._rs || {};
    this._rs[name] = setTimeout(async () => {
      const moved = await this.streamsOn(name);                // потоки на нашем устройстве до пересборки
      const wasDef = (await run('pactl', [name === 'out' ? 'get-default-sink' : 'get-default-source']))?.trim() === (name === 'out' ? SINK : SOURCE);
      if (name === 'out') await this.prepHrir();
      const demo = name === 'out' && this.demo ? { kind: this.demo.kind, t0: this.demo.t0 } : null;
      if (demo) await this.stopDemo();
      await this.spawnChain(name, name === 'out' ? this.renderConf(this.state) : this.micConf(this.state));
      await this.waitNode(name === 'out' ? SINK : SOURCE);
      if (demo) this.playDemo(demo.kind, (Date.now() - demo.t0) / 1000);
      await this.rescueStreams(name, moved);
      if (wasDef) await run('pactl', [name === 'out' ? 'set-default-sink' : 'set-default-source', name === 'out' ? SINK : SOURCE]);
    }, 150);
  }

  // --- сохранение потоков при пересборке графа ---
  async streamsOn(name) {
    const kind = name === 'out' ? 'sink' : 'source';
    const devs = await audio.listJson(kind + 's');
    const idx = devs.find(d => d.name === (name === 'out' ? SINK : SOURCE))?.index;
    const items = await audio.listJson(kind === 'sink' ? 'sink-inputs' : 'source-outputs');
    return items.filter(i => i[kind] === idx && !String(i.properties?.['node.name'] || '').startsWith('v9hub_')).map(i => i.index);
  }
  async waitNode(nodeName) {
    for (let i = 0; i < 40; i++) {
      const out = await run('pactl', ['list', 'short', nodeName === SINK ? 'sinks' : 'sources']);
      if (out && out.split('\n').some(l => l.split('\t')[1] === nodeName)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }
  async rescueStreams(name, prev) {
    const out = name === 'out';
    const items = await audio.listJson(out ? 'sink-inputs' : 'source-outputs');
    for (const i of items) {
      if (String(i.properties?.['node.name'] || '').startsWith('v9hub_')) continue;
      const orphan = (out ? i.sink : i.source) === 4294967295;
      if (prev.includes(i.index) || orphan) {
        await run('pactl', [out ? 'move-sink-input' : 'move-source-output', String(i.index), out ? SINK : SOURCE]);
        this.log('поток возвращён на M HUB', i.index, i.properties?.['application.name']);
      }
    }
  }

  async nodeId(name) {
    if (this.nodeIds[name] != null) return this.nodeIds[name];
    const out = await run('pw-dump', []);
    if (!out) return null;
    try {
      const objs = JSON.parse(out);
      const n = objs.find(o => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === name);
      if (n) this.nodeIds[name] = n.id;
      return n?.id ?? null;
    } catch { return null; }
  }

  async setParams(nodeName, params) {
    const id = await this.nodeId(nodeName);
    if (id == null) return;
    const body = Object.entries(params).map(([k, v]) => `"${k}" ${Number(v)}`).join(' ');
    await run('pw-cli', ['set-param', String(id), 'Props', `{ params = [ ${body} ] }`]);
  }

  async applyLive(field) {
    const st = this.state, p = {};
    const isMic = /VOICECLARITY|MICVOLUME|NR$|MAGICVOICE|MagicVoice/.test(field || '');
    if (isMic) {
      p['gate:enabled'] = st.VOICECLARITY_LFX && st.VOICECLARITY_NOISESUPP_LEVEL > 0 ? 1 : 0;
      p['gate:gr'] = db2lin(-(st.VOICECLARITY_NOISESUPP_LEVEL || 0));
      p['pres:Gain'] = st.VOICECLARITY_LFX ? (st.VOICECLARITY_LEVEL || 0) * 0.8 : 0;
      p['lev:enabled'] = st.MICVOLUMELEVELING ? 1 : 0;
      const mv = this.voiceParams(st);
      Object.assign(p, { 'voice:Semitones': mv.semi, 'voice:Tone': mv.tone, 'voice:Ring (Hz)': mv.ring, 'voice:Mix': mv.mix });
      return this.setParams(SOURCE, p);
    }
    for (const ear of ['L', 'R']) {
      this.p.eq.forEach((_, i) => { const b = this.eqBand(i, st); p[`eq${i}_${ear}:Gain`] = b.gain; p[`eq${i}_${ear}:Q`] = b.q; });
      const br = this.brightParams(st), vb = this.vbassParams(st);
      Object.assign(p, { [`br_${ear}:Freq`]: br.freq, [`br_${ear}:Q`]: br.q, [`br_${ear}:Gain`]: br.gain, [`brg_${ear}:Mult`]: db2lin(br.lift),
        [`vb_${ear}:Freq`]: vb.lsf, [`vb_${ear}:Q`]: vb.lsq, [`vb_${ear}:Gain`]: vb.lsg,
        [`vbp_${ear}:Freq`]: vb.pkf, [`vbp_${ear}:Q`]: vb.pkq, [`vbp_${ear}:Gain`]: vb.pkg, [`vbg_${ear}:Mult`]: db2lin(vb.lift) });
    }
    const av = this.avParams(st);
    for (const k of ['enabled', 'al', 'cr', 'mk', 'rt', 'scm']) p[`av:${k}`] = av[k];
    await this.setParams(SINK, p);
  }

  // Как в Windows: устройства M HUB становятся устройствами по умолчанию при запуске и при открытии страницы
  // гарнитуры (setToDefault). Потоки с прежнего устройства по умолчанию и с самой гарнитуры переезжают на M HUB.
  // Прежние устройства запоминаются и возвращаются при выходе.
  async makeDefault() {
    const defSink = (await run('pactl', ['get-default-sink']))?.trim();
    const defSrc = (await run('pactl', ['get-default-source']))?.trim();
    if (this.hwSink && defSink && defSink !== SINK) {
      if (!this.prevSink) this.prevSink = defSink;
      await run('pactl', ['set-default-sink', SINK]);
      const sinks = await audio.listJson('sinks');
      const from = new Set(sinks.filter(s => s.name === defSink || s.name === this.hwSink).map(s => s.index));
      for (const i of await audio.listJson('sink-inputs')) {
        if (from.has(i.sink) && !String(i.properties?.['node.name'] || '').startsWith('v9hub_')) await run('pactl', ['move-sink-input', String(i.index), SINK]);
      }
    }
    if (this.hwSource && defSrc && defSrc !== SOURCE) {
      if (!this.prevSource) this.prevSource = defSrc;
      await run('pactl', ['set-default-source', SOURCE]);
      const srcs = await audio.listJson('sources');
      const from = new Set(srcs.filter(s => s.name === defSrc || s.name === this.hwSource).map(s => s.index));
      for (const o of await audio.listJson('source-outputs')) {
        if (from.has(o.source) && !String(o.properties?.['node.name'] || '').startsWith('v9hub_')) await run('pactl', ['move-source-output', String(o.index), SOURCE]);
      }
    }
    return true;
  }

  // Тест колонок. Интерфейс вызывает playTestSound(i) по очереди, i — колонка на схеме:
  // 0 тыл-Л, 1 Л, 2 фронт-Л, 3 центр, 4 фронт-П, 5 П, 6 тыл-П, 7 сабвуфер.
  // Звуки синтезируются (lib/testsig.cjs) один раз и кешируются как 8-канальные WAV.
  testFile(name, make) {
    const dir = path.join(this.dir, 'test'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `v${testsig.VERSION}-${name}.wav`);
    if (!fs.existsSync(f)) { fs.writeFileSync(f + '.part', make().wav()); fs.renameSync(f + '.part', f); }
    return f;
  }
  prepareTestSounds() {
    // Фоном, чтобы первый клик не ждал синтеза
    setTimeout(() => {
      for (const k of ['steps', 'cinema']) for (let i = 0; i < 8; i++) this.testFile(`${k}-${i}`, () => testsig.speakerClip(k, i));
    }, 2000);
  }
  play(file, key) {
    if (!this.hwSink) return null;     // движок не запущен: не играем, иначе звук уйдёт на устройство по умолчанию
    // node.dont-move: менеджеры звука (например, со своим стерео-синком) не должны перехватывать 8-канальный тест
    const p = spawn('pw-play', ['--target', SINK, '--media-role', 'Notification', '-P', '{ node.dont-move = true }', file], { stdio: 'ignore' });
    this.tests = (this.tests || new Set()).add(p);
    p.on('exit', () => this.tests.delete(p)); p.on('error', () => this.tests.delete(p));
    if (key) this[key] = p;
    return p;
  }
  async testSpeaker(i) {
    const k = this.testKind || 'steps', n = Number(i) | 0;
    // Предыдущий звук не глушим: интерфейс сам выдерживает длительность каждой колонки
    this.play(this.testFile(`${k}-${n}`, () => testsig.speakerClip(k, n)));
    return true;
  }
  // Демо-дорожка. Играется через pw-cat из памяти, чтобы после пересборки графа (смена профиля HRTF, режима,
  // комнаты) продолжить с того же места: поток закреплён за нашим устройством и сам на новое не переезжает.
  async playDemo(kind = 'steps', offset = 0) {
    await this.stopDemo();
    if (!this.hwSink) return false;
    const f = this.testFile(`demo-${kind}`, () => testsig.demo(kind));
    const buf = fs.readFileSync(f), data = buf.indexOf('data') + 8;
    const from = data + Math.min(Math.floor(offset * 48000) * 32, buf.length - data);
    const p = spawn('pw-cat', ['--playback', '--raw', '--target', SINK, '--format', 'f32', '--rate', '48000', '--channels', '8',
      '--channel-map', CH8.join(','), '--media-role', 'Notification', '-P', '{ node.dont-move = true }', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.on('error', () => {}); p.stdin.end(buf.subarray(from));
    this.demo = { proc: p, kind, t0: Date.now() - offset * 1000 };
    p.on('exit', () => { if (this.demo?.proc === p) this.demo = null; });
    return new Promise(res => p.on('spawn', () => res(true)).on('error', () => res(false)));
  }
  async stopDemo() { const d = this.demo; this.demo = null; d?.proc.kill(); return true; }
  async testSound() { return this.testSpeaker(3); }
  async stopTestSound() { return true; }   // клипы короткие и доигрывают сами

  // Прослушивание микрофона в наушниках
  async setMicMonitor(on) {
    this.micMonitor = on;
    if (this.loopback) { this.loopback.kill(); this.loopback = null; }
    if (on) {
      this.loopback = spawn('pw-loopback', ['--capture-props', `node.target=${SOURCE} target.object=${SOURCE} node.name=v9hub_monitor_in node.passive=true`,
        '--playback-props', `target.object=${this.hwSink} node.name=v9hub_monitor_out media.role=Communication`, '--latency', '10ms'], { stdio: 'ignore' });
    }
    return undefined;
  }

  stop() {
    clearInterval(this._wait);
    this.stopDemo(); this.setMicMonitor(false);
    // Возвращаем устройства по умолчанию на гарнитуру, если они указывали на наши виртуальные
    try {
      const { execFileSync } = require('node:child_process');
      const ds = execFileSync('pactl', ['get-default-sink']).toString().trim();
      if (ds === SINK) execFileSync('pactl', ['set-default-sink', this.prevSink || this.hwSink]);
      const dsrc = execFileSync('pactl', ['get-default-source']).toString().trim();
      if (dsrc === SOURCE) execFileSync('pactl', ['set-default-source', this.prevSource || this.hwSource]);
    } catch {}
    this.kill('out'); this.kill('mic');
  }
}

module.exports = { Dsp, SINK, SOURCE };
