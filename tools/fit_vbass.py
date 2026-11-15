#!/usr/bin/env python3
"""Точная подгонка Dynamic Low Frequency (Virtual Bass) C-Media.
Измерения в VM сняты с включённым Brightening L1, поэтому эталон делится на q2_bright1.
Модель: lowshelf(fs,Qs,gs) * peaking(fp,Qp,gp) * общий множитель. Подгонка Нелдером–Мидом.
Результат дописывается в dsp/params.json -> virtualbass2.
"""
import json, os, sys
import numpy as np

MEAS, OUT = sys.argv[1], sys.argv[2]
FS = 48000; N = 1 << 15
FF = np.fft.rfftfreq(N, 1 / FS)
F = np.geomspace(15, 20000, 300)

def H(name):
    h = np.fft.rfft(np.load(os.path.join(MEAS, name))['irs'][0, 0], N)
    return np.interp(F, FF, np.abs(h))

def bq(kind, f0, Q, g):
    A = 10 ** (g / 40); w0 = 2 * np.pi * f0 / FS; al = np.sin(w0) / (2 * Q); c = np.cos(w0)
    if kind == 'pk':
        b = [1 + al * A, -2 * c, 1 - al * A]; a = [1 + al / A, -2 * c, 1 - al / A]
    else:
        sA = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * c + sA), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sA)]
        a = [(A + 1) + (A - 1) * c + sA, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sA]
    z = np.exp(-1j * 2 * np.pi * F / FS)
    return 20 * np.log10(np.abs((b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z)))

def model(x):
    fs, Qs, gs, fp, Qp, gp, lift = x
    return bq('ls', fs, Qs, gs) + bq('pk', fp, Qp, gp) + lift

def nelder(f, x0, step, iters=3000):
    n = len(x0); pts = [np.array(x0, float)] + [np.array(x0, float) + np.eye(n)[i] * step[i] for i in range(n)]
    vals = [f(p) for p in pts]
    for _ in range(iters):
        o = np.argsort(vals); pts = [pts[i] for i in o]; vals = [vals[i] for i in o]
        c = np.mean(pts[:-1], axis=0); r = c + (c - pts[-1]); fr = f(r)
        if fr < vals[0]:
            e = c + 2 * (c - pts[-1]); fe = f(e)
            pts[-1], vals[-1] = (e, fe) if fe < fr else (r, fr)
        elif fr < vals[-2]: pts[-1], vals[-1] = r, fr
        else:
            k = c + 0.5 * (pts[-1] - c); fk = f(k)
            if fk < vals[-1]: pts[-1], vals[-1] = k, fk
            else:
                pts = [pts[0]] + [pts[0] + 0.5 * (p - pts[0]) for p in pts[1:]]; vals = [f(p) for p in pts]
    i = int(np.argmin(vals)); return pts[i], vals[i]

ref = H('q2_bright1.npz')
res = {}
band = (F > 18) & (F < 16000)
for lv, fq in ((2, 200), (5, 200), (10, 200), (10, 100), (10, 400)):
    t = 20 * np.log10(H(f'q2_vbass_l{lv}_f{fq}.npz') / ref)
    def cost(x):
        fs, Qs, gs, fp, Qp, gp, lift = x
        if not (20 < fs < 2000 and 0.2 < Qs < 4 and 20 < fp < 2000 and 0.2 < Qp < 8 and -20 < gs < 20 and -20 < gp < 20): return 1e9
        d = model(x)[band] - t[band]
        return float(np.sqrt(np.mean(d * d)))
    best = None
    for fs0 in (0.8, 1.2, 1.8):
        for fp0 in (1.2, 1.6, 2.2):
            x, v = nelder(cost, [fq * fs0, 0.7, lv * 0.5, fq * fp0, 1.5, lv * 0.4, 0], [fq * 0.3, 0.3, 2, fq * 0.3, 0.6, 2, 0.5])
            if best is None or v < best[1]: best = (x, v)
    x, v = best
    res[f'{lv}_{fq}'] = dict(zip(['ls_freq', 'ls_q', 'ls_gain', 'pk_freq', 'pk_q', 'pk_gain', 'lift'], [round(float(a), 3) for a in x]))
    res[f'{lv}_{fq}']['err_db'] = round(v, 3)
    print(f'L{lv} F{fq}: err {v:.2f} дБ ->', res[f'{lv}_{fq}'])

p = json.load(open(os.path.join(OUT, 'params.json')))
p['virtualbass2'] = res
json.dump(p, open(os.path.join(OUT, 'params.json'), 'w'), ensure_ascii=False, indent=1)
