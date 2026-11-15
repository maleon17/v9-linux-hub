#!/usr/bin/env python3
"""Подгонка параметров DSP под измерения оригинального C-Media APO (work/measurements/*.npz).

Выход: dsp/params.json (EQ-полосы, brightening, virtual bass, сведение).
"""
import json, os, sys, struct
import numpy as np

MEAS = sys.argv[1]
OUT = sys.argv[2]
FS = 48000
N = 1 << 15
FFULL = np.fft.rfftfreq(N, 1 / FS)
F = np.geomspace(15, 21000, 400)          # логарифмическая сетка для подгонки

def load(name, amp_db):
    d = np.load(os.path.join(MEAS, name))['irs'] / (10 ** (amp_db / 20))
    return d

def H(ir):
    h = np.fft.rfft(ir, N)
    return np.interp(F, FFULL, h.real) + 1j * np.interp(F, FFULL, h.imag)

def mag_db(h):
    return 20 * np.log10(np.abs(h) + 1e-12)

# --- RBJ биквады (как в PipeWire builtin bq_*) ---
def biquad(kind, f0, Q, gain_db):
    A = 10 ** (gain_db / 40); w0 = 2 * np.pi * f0 / FS; alpha = np.sin(w0) / (2 * Q); c = np.cos(w0)
    if kind == 'peaking':
        b = [1 + alpha * A, -2 * c, 1 - alpha * A]; a = [1 + alpha / A, -2 * c, 1 - alpha / A]
    elif kind == 'lowshelf':
        sA = 2 * np.sqrt(A) * alpha
        b = [A * ((A + 1) - (A - 1) * c + sA), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sA)]
        a = [(A + 1) + (A - 1) * c + sA, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sA]
    elif kind == 'highshelf':
        sA = 2 * np.sqrt(A) * alpha
        b = [A * ((A + 1) + (A - 1) * c + sA), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sA)]
        a = [(A + 1) - (A - 1) * c + sA, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sA]
    elif kind == 'lowpass':
        b = [(1 - c) / 2, 1 - c, (1 - c) / 2]; a = [1 + alpha, -2 * c, 1 - alpha]
    z = np.exp(-1j * 2 * np.pi * F / FS)
    return (b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z)

band = (F > 15) & (F < 21000)
W = np.ones(band.sum()) / band.sum()   # сетка уже логарифмическая -> равный вес по октавам

def err(model_db, target_db):
    return float(np.sqrt(np.sum(W * (model_db[band] - target_db[band]) ** 2)))

params = {}

# ---------- EQ: каждая полоса +12 дБ ----------
base2 = H(load('ir-base2.npz', -12)[0, 0])
eq = []
centers = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
for b, fc in enumerate(centers):
    t = mag_db(H(load(f'ir-eqb{b}p12.npz', -12)[0, 0]) / base2)
    best = None
    for f0 in fc * 2 ** np.linspace(-0.4, 0.4, 41):
        for Q in np.linspace(0.25, 3.0, 56):
            for g in (11.6, 11.8, 12.0, 12.2):
                e = err(mag_db(biquad('peaking', f0, Q, g)), t)
                if best is None or e < best[0]: best = (e, f0, Q, g)
    # общий сдвиг (APO слегка ослабляет остальные частоты)
    off = float(np.median(t[(F > 15) & (F < 21000)][np.abs(t[(F > 15) & (F < 21000)]) < 0.6]))
    eq.append({'freq': round(best[1], 2), 'q': round(best[2], 3), 'err_db': round(best[0], 3), 'gain12': best[3], 'offset_db': round(off, 2)})
    print(f'EQ band {b}: f={best[1]:.1f} Q={best[2]:.2f} err={best[0]:.2f} dB offset={off:+.2f}')
params['eq'] = eq

# проверка каскада на пресете CS1
cs1 = [10, -5, 10, -2, 3, 2, 2, 5, 3, 2]
model = np.ones_like(F, dtype=complex)
for p, g in zip(eq, cs1): model *= biquad('peaking', p['freq'], p['q'], g)
t = mag_db(H(load('ir-eqCS1.npz', -12)[0, 0]) / base2)
print(f'CS1 каскад: ошибка {err(mag_db(model), t):.2f} дБ (без поправки)')
for gain_comp in np.linspace(-3, 0, 31):
    pass
params['eq_cs1_err'] = err(mag_db(model), t)

# ---------- Brightening: highshelf + общий гейн ----------
qbase = H(load('q2_base.npz', -30)[0, 0])
bright = {}
for lv in (1, 3, 6, 10):
    t = mag_db(H(load(f'q2_bright{lv}.npz', -30)[0, 0]) / qbase)
    best = None
    for f0 in np.geomspace(1500, 16000, 40):
        for Q in np.linspace(0.3, 1.2, 19):
            for g in np.linspace(2, 16, 57):
                m = mag_db(biquad('highshelf', f0, Q, g))
                lift = float(np.median((t - m)[(F > 40) & (F < 600)]))
                e = err(m + lift, t)
                if best is None or e < best[0]: best = (e, f0, Q, g, lift)
    bright[lv] = {'freq': round(best[1], 1), 'q': round(best[2], 3), 'gain': round(best[3], 2), 'lift': round(best[4], 2), 'err_db': round(best[0], 3)}
    print(f'Bright L{lv}: shelf f={best[1]:.0f} Q={best[2]:.2f} g={best[3]:.1f} lift={best[4]:+.2f} err={best[0]:.2f}')
params['brightening'] = bright

# ---------- Virtual bass: peaking + lowpass-подобный спад ----------
vb = {}
for lv, fq in ((2, 200), (5, 200), (10, 200), (10, 100), (10, 400)):
    t = mag_db(H(load(f'q2_vbass_l{lv}_f{fq}.npz', -30)[0, 0]) / qbase)
    best = None
    for f0 in fq * np.geomspace(0.6, 3.5, 48):
        for Q in np.linspace(0.3, 5.0, 48):
            for g in np.linspace(1, 14, 53):
                m = mag_db(biquad('lowshelf', f0, Q, g))
                lift = float(np.median((t - m)[(F > 2000) & (F < 8000)]))
                e = err(m + lift, t)
                if best is None or e < best[0]: best = (e, f0, Q, g, lift)
    vb[f'{lv}_{fq}'] = {'level': lv, 'cutoff': fq, 'freq': round(best[1], 1), 'q': round(best[2], 3), 'gain': round(best[3], 2), 'lift': round(best[4], 2), 'err_db': round(best[0], 3)}
    print(f'VBass L{lv} F{fq}: lowshelf f={best[1]:.0f} Q={best[2]:.2f} g={best[3]:.1f} lift={best[4]:+.2f} err={best[0]:.2f}')
params['virtualbass'] = vb

# Сведение 7.1 -> 2 при выключенном виртуальном 7.1 (измерено)
params['downmix'] = {'FL': [1, 0], 'FR': [0, 1], 'FC': [0.7071, 0.7071], 'LFE': [1, 1], 'RL': [1, 0], 'RR': [0, 1], 'SL': [1, 0], 'SR': [0, 1]}
# Intelligent volume (по ступенчатому тону; сдвиг измерения +0.7 дБ учтён)
params['adaptive_volume'] = {
    'mode0': {'threshold_db': -60, 'ratio': 1.75, 'makeup_db': '2 + 0.2*level'},
    'mode1': {'threshold_db': -42, 'ratio': 8.0, 'makeup_db': '6 + 0.18*level'},
}
params['limiter_db'] = -1.0
json.dump(params, open(os.path.join(OUT, 'params.json'), 'w'), ensure_ascii=False, indent=1)
print('ok')
