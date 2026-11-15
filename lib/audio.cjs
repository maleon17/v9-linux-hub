'use strict';
// Громкость/mute гарнитуры через PipeWire (pactl). Аппаратные sink/source V9 Pro ищутся по имени.
const { execFile } = require('node:child_process');

const MATCH = /MCHOSE_V9_PRO/i;

function pactl(args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: 4000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function listJson(kind) {
  try { return JSON.parse(await pactl(['-f', 'json', 'list', kind])); } catch { return []; }
}

// Аппаратные sink/source гарнитуры (для движка)
async function findHw(type) {
  const kind = type === 'mic' ? 'sources' : 'sinks';
  const items = await listJson(kind);
  return items.find(d => MATCH.test(d.name) && !/\.monitor$/.test(d.name) && d.properties?.['device.class'] !== 'filter') || null;
}

// Устройство, которым управляют ползунки M HUB: как в Windows — виртуальное устройство M HUB
// (оно же устройство по умолчанию), а если движок не запущен — сама гарнитура.
const VIRTUAL = { speaker: 'v9hub_surround', mic: 'v9hub_mic' };
async function findDevice(type) {
  const kind = type === 'mic' ? 'sources' : 'sinks';
  const items = await listJson(kind);
  return items.find(d => d.name === VIRTUAL[type === 'mic' ? 'mic' : 'speaker']) || findHwIn(items);
}
function findHwIn(items) {
  return items.find(d => MATCH.test(d.name) && !/\.monitor$/.test(d.name) && d.properties?.['device.class'] !== 'filter') || null;
}

function avgVolume(dev) {
  const v = Object.values(dev.volume || {});
  if (!v.length) return 0;
  return v.reduce((a, c) => a + c.value, 0) / v.length / 65536;
}

async function getVolume(type) {
  const d = await findDevice(type);
  return d ? Math.min(1, avgVolume(d)) : null;
}

async function setVolume(type, scalar) {
  const d = await findDevice(type);
  if (!d) return null;
  const pct = Math.round(Math.max(0, Math.min(1, scalar)) * 100);
  await pactl([type === 'mic' ? 'set-source-volume' : 'set-sink-volume', d.name, `${pct}%`]);
  return scalar;
}

async function getMute(type) {
  const d = await findDevice(type);
  return d ? !!d.mute : null;
}

async function setMute(type, muted) {
  const d = await findDevice(type);
  if (!d) return null;
  await pactl([type === 'mic' ? 'set-source-mute' : 'set-sink-mute', d.name, muted ? '1' : '0']);
  return muted;
}

async function friendlyName(type) {
  const d = await findDevice(type);
  if (!d) return null;
  return type === 'mic' ? 'Mic (MCHOSE V9 PRO)' : 'Speakers (MCHOSE V9 PRO)';
}

// Подписка на изменения громкости (pactl subscribe) -> колбэк({type, volume, muted})
function watch(onChange) {
  const { spawn } = require('node:child_process');
  const p = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let timer = null;
  p.stdout.on('data', buf => {
    if (!/'change' on (sink|source) #/.test(buf.toString())) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      for (const type of ['speaker', 'mic']) {
        const d = await findDevice(type);
        if (d) onChange({ type, volume: Math.min(1, avgVolume(d)), muted: !!d.mute });
      }
    }, 80);
  });
  return () => p.kill();
}

module.exports = { pactl, listJson, findDevice, findHw, getVolume, setVolume, getMute, setMute, friendlyName, watch };
