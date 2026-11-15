'use strict';
// Эмуляция C-Media Audio SDK (cmedia_2025) поверх Linux: состояние эффектов -> DSP-движок PipeWire,
// громкость/mute -> pactl. Имена методов, диапазоны и значения по умолчанию сняты с оригинала в VM.
const audio = require('./audio.cjs');

const DEFAULTS = Object.freeze({
  EQ_GFX: false, EQ: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  AUDIOBRILLIANT_LFX: false, AUDIOBRILLIANT_LEVEL: 3,
  VIRTUALBASS_LFX: false, VIRTUALBASS_Level: 5, VIRTUALBASS_CutOffFrequency: 200,
  ADAPTIVEVOLUME_GFX: false, ADAPTIVEVOLUME_LEVEL: 50, ADAPTIVEVOLUME_MODE: 0,
  VOICECLARITY_LFX: false, VOICECLARITY_LEVEL: 3, VOICECLARITY_NOISESUPP_LEVEL: 0,
  MAGICVOICE: false, MagicVoice_Selection: 0,
  MICVOLUMELEVELING: false, MICVOLUMELEVELING_LEVEL: 50,
  Channel_COPY_LFX: false, NR: false,
  AINR: false, AINRLevel: 50,
  XearSurroundEnable: false, XearSurroundMode: 0, XearSurroundRoom: 1,
});

// Карта «метод SDK -> поле состояния»
const FIELD = {
  Enable_EQ_GFX: 'EQ_GFX', Enable_AUDIOBRILLIANT_LFX: 'AUDIOBRILLIANT_LFX', AUDIOBRILLIANT_LEVEL: 'AUDIOBRILLIANT_LEVEL',
  Enable_VIRTUALBASS_LFX: 'VIRTUALBASS_LFX', VIRTUALBASS_Level: 'VIRTUALBASS_Level',
  VIRTUALBASS_CutOffFrequency: 'VIRTUALBASS_CutOffFrequency', Enable_ADAPTIVEVOLUME_GFX: 'ADAPTIVEVOLUME_GFX',
  ADAPTIVEVOLUME_LEVEL: 'ADAPTIVEVOLUME_LEVEL', ADAPTIVEVOLUME_MODE: 'ADAPTIVEVOLUME_MODE',
  Enable_VOICECLARITY_LFX: 'VOICECLARITY_LFX', VOICECLARITY_LEVEL: 'VOICECLARITY_LEVEL',
  VOICECLARITY_NOISESUPP_LEVEL: 'VOICECLARITY_NOISESUPP_LEVEL', Enable_MAGICVOICE: 'MAGICVOICE',
  MagicVoice_Selection: 'MagicVoice_Selection', Enable_MICVOLUMELEVELING: 'MICVOLUMELEVELING',
  MICVOLUMELEVELING_LEVEL: 'MICVOLUMELEVELING_LEVEL', Enable_Channel_COPY_LFX: 'Channel_COPY_LFX',
  NR_Enable: 'NR', AINREnable: 'AINR', AINRLevel: 'AINRLevel',
  XearSurroundEnable: 'XearSurroundEnable', XearSurroundMode: 'XearSurroundMode', XearSurroundRoom: 'XearSurroundRoom',
};

class Sdk {
  constructor({ store, dsp, log }) {
    this.cfg = store.config('linux-dsp');
    this.state = { ...DEFAULTS, ...this.cfg.data };
    this.dsp = dsp; this.log = log || (() => {});
    this.deviceId = 'MCHOSE V9 PRO PID14429';
  }
  _save() { this.cfg.data = this.state; this.cfg.save(); }
  _changed(field) { this._save(); this.dsp?.update(this.state, field); }

  async call(method, args = []) {
    const [deviceId, ...a] = args;
    const ok = data => ({ success: true, deviceId: deviceId ?? this.deviceId, method, data });
    try {
      const data = await this.invoke(method, a);
      return ok(data);
    } catch (e) {
      this.log('sdk error', method, e.message);
      return { success: false, deviceId, method, code: 'LINUX_SDK_ERROR', message: e.message };
    }
  }

  // Прямые методы (через audio-sdk:call и одноимённые IPC-каналы)
  async invoke(method, a) {
    const st = this.state;
    const m = /^([gs]et)(.+)$/i.exec(method);
    switch (method) {
      case 'getVolumeScalarControl': return (await audio.getVolume(a[1] ?? 'speaker')) ?? 0;
      case 'setVolumeScalarControl': await audio.setVolume(a[2] ?? 'speaker', a[1]); return a[1];
      case 'getMuteControl': return (await audio.getMute(a[0] ?? 'speaker')) ?? false;
      case 'setMuteControl': await audio.setMute(a[1] ?? 'speaker', !!a[0]); return !!a[0];
      case 'getDeviceFriendlyName': return (await audio.friendlyName(a[0] ?? 'speaker')) ?? '';
      case 'setToDefault': await this.dsp?.makeDefault(); return true;
      case 'getEQ_Slider': case 'GetEQ_Slider': return st.EQ[a[0]] ?? 0;
      case 'setEQ_Slider': {
        const band = a[0] | 0, v = Math.max(-20, Math.min(20, Number(a[1]) || 0));
        st.EQ = st.EQ.slice(); st.EQ[band] = v; this._changed('EQ'); return v;
      }
      case 'playTestSound': await this.dsp?.testSpeaker(a[0]); return true;
      case 'startTestSound': await this.dsp?.testSound(a[0]); return true;
      case 'stopTestSound': await this.dsp?.stopTestSound(); return true;
    }
    if (m) {
      const key = m[2];
      const field = FIELD[key];
      if (field) {
        if (m[1].toLowerCase() === 'get') return st[field];
        const v = typeof DEFAULTS[field] === 'boolean' ? !!a[0] : Number(a[0]);
        st[field] = v; this._changed(field); return v;
      }
    }
    this.log('sdk: неизвестный метод', method, JSON.stringify(a));
    return null;
  }

  reset() { this.state = { ...DEFAULTS }; this._changed('*'); }
}

module.exports = { Sdk, DEFAULTS };
