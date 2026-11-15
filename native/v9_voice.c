/*
 * v9_voice — LADSPA-плагин изменения голоса (эффекты «Magic Voice»).
 * Питч-шифтер на линии задержки: две читающие головки со сдвигом в половину окна,
 * скорость чтения = 2^(semitones/12), перекрёстное затухание по Ханну. Плюс простой
 * формантный сдвиг через фильтр первого порядка (tone) и кольцевой модулятор (для «монстра»).
 * Сборка: cc -O2 -fPIC -shared -o v9_voice.so v9_voice.c -lm
 */
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* --- минимальный ABI LADSPA (совпадает с ladspa.h v1.1) --- */
typedef float LADSPA_Data;
typedef void *LADSPA_Handle;
typedef int LADSPA_Properties;
typedef int LADSPA_PortDescriptor;
typedef int LADSPA_PortRangeHintDescriptor;
typedef struct { LADSPA_PortRangeHintDescriptor HintDescriptor; LADSPA_Data LowerBound, UpperBound; } LADSPA_PortRangeHint;
typedef struct _LADSPA_Descriptor {
  unsigned long UniqueID; const char *Label; LADSPA_Properties Properties; const char *Name, *Maker, *Copyright;
  unsigned long PortCount; const LADSPA_PortDescriptor *PortDescriptors; const char *const *PortNames;
  const LADSPA_PortRangeHint *PortRangeHints; void *ImplementationData;
  LADSPA_Handle (*instantiate)(const struct _LADSPA_Descriptor *, unsigned long);
  void (*connect_port)(LADSPA_Handle, unsigned long, LADSPA_Data *);
  void (*activate)(LADSPA_Handle);
  void (*run)(LADSPA_Handle, unsigned long);
  void (*run_adding)(LADSPA_Handle, unsigned long);
  void (*set_run_adding_gain)(LADSPA_Handle, LADSPA_Data);
  void (*deactivate)(LADSPA_Handle);
  void (*cleanup)(LADSPA_Handle);
} LADSPA_Descriptor;
#define PORT_INPUT 0x1
#define PORT_OUTPUT 0x2
#define PORT_CONTROL 0x4
#define PORT_AUDIO 0x8
#define HINT_BOUNDED_BELOW 0x1
#define HINT_BOUNDED_ABOVE 0x2
#define HINT_DEFAULT_0 0x200
#define HINT_DEFAULT_MIDDLE 0x80
#define HINT_DEFAULT_MINIMUM 0x40

enum { P_IN, P_OUT, P_SEMI, P_WINDOW, P_TONE, P_RING, P_MIX, P_COUNT };
#define BUF 16384

typedef struct {
  float *port[P_COUNT];
  float rate;
  float buf[BUF];
  unsigned w;
  double phase;      /* 0..1 положение головки внутри окна */
  float lp;          /* состояние tone-фильтра */
  double ringph;
} Voice;

static LADSPA_Handle inst(const LADSPA_Descriptor *d, unsigned long sr) {
  (void)d; Voice *v = calloc(1, sizeof(Voice)); v->rate = (float)sr; return v;
}
static void conn(LADSPA_Handle h, unsigned long p, LADSPA_Data *d) { ((Voice *)h)->port[p] = d; }
static void act(LADSPA_Handle h) { Voice *v = h; memset(v->buf, 0, sizeof v->buf); v->w = 0; v->phase = 0; v->lp = 0; v->ringph = 0; }

static inline float rd(const Voice *v, float delay) {
  float pos = (float)v->w - delay; while (pos < 0) pos += BUF;
  unsigned i0 = (unsigned)pos; float f = pos - (float)i0;
  float a = v->buf[i0 % BUF], b = v->buf[(i0 + 1) % BUF];
  return a + (b - a) * f;
}

static void run(LADSPA_Handle h, unsigned long n) {
  Voice *v = h;
  const float *in = v->port[P_IN]; float *out = v->port[P_OUT];
  float semi = *v->port[P_SEMI], winms = *v->port[P_WINDOW], tone = *v->port[P_TONE];
  float ring = *v->port[P_RING], mix = *v->port[P_MIX];
  float ratio = powf(2.f, semi / 12.f);
  float win = winms * 0.001f * v->rate; if (win < 256) win = 256; if (win > BUF / 2 - 4) win = BUF / 2 - 4;
  double dphase = (1.0 - ratio) / win;               /* скорость изменения задержки */
  float a = expf(-2.f * (float)M_PI * (200.f + 7800.f * (1.f - fabsf(tone))) / v->rate);
  for (unsigned long i = 0; i < n; i++) {
    v->buf[v->w] = in[i];
    double p1 = v->phase, p2 = fmod(v->phase + 0.5, 1.0);
    float d1 = (float)(p1 * win) + 2.f, d2 = (float)(p2 * win) + 2.f;
    float g1 = sinf((float)M_PI * (float)p1), g2 = sinf((float)M_PI * (float)p2);   /* g1²+g2²=1 */
    float y = rd(v, d1) * g1 * g1 + rd(v, d2) * g2 * g2;
    v->phase += dphase; if (v->phase >= 1.0) v->phase -= 1.0; if (v->phase < 0.0) v->phase += 1.0;
    /* tone: <0 — темнее (НЧ-фильтр), >0 — ярче (вычитание НЧ) */
    v->lp = v->lp * a + y * (1.f - a);
    if (tone < 0) y = v->lp; else if (tone > 0) y = y + (y - v->lp) * tone;
    if (ring > 0) { y *= (1.f - 0.6f) + 0.6f * (float)sin(2 * M_PI * v->ringph); v->ringph += ring / v->rate; if (v->ringph > 1) v->ringph -= 1; }
    out[i] = in[i] * (1.f - mix) + y * mix;
    v->w = (v->w + 1) % BUF;
  }
}
static void clean(LADSPA_Handle h) { free(h); }

static const LADSPA_PortDescriptor pd[P_COUNT] = {
  PORT_INPUT | PORT_AUDIO, PORT_OUTPUT | PORT_AUDIO, PORT_INPUT | PORT_CONTROL, PORT_INPUT | PORT_CONTROL,
  PORT_INPUT | PORT_CONTROL, PORT_INPUT | PORT_CONTROL, PORT_INPUT | PORT_CONTROL };
static const char *const pn[P_COUNT] = { "Input", "Output", "Semitones", "Window (ms)", "Tone", "Ring (Hz)", "Mix" };
static const LADSPA_PortRangeHint ph[P_COUNT] = {
  { 0, 0, 0 }, { 0, 0, 0 },
  { HINT_BOUNDED_BELOW | HINT_BOUNDED_ABOVE | HINT_DEFAULT_0, -12, 12 },
  { HINT_BOUNDED_BELOW | HINT_BOUNDED_ABOVE | HINT_DEFAULT_MIDDLE, 20, 120 },
  { HINT_BOUNDED_BELOW | HINT_BOUNDED_ABOVE | HINT_DEFAULT_0, -1, 1 },
  { HINT_BOUNDED_BELOW | HINT_BOUNDED_ABOVE | HINT_DEFAULT_MINIMUM, 0, 200 },
  { HINT_BOUNDED_BELOW | HINT_BOUNDED_ABOVE | HINT_DEFAULT_MINIMUM, 0, 1 } };

static const LADSPA_Descriptor desc = {
  0x4D485601, "v9_voice", 0, "V9 Linux Hub voice changer", "v9-linux-hub", "GPL-3.0-or-later",
  P_COUNT, pd, pn, ph, NULL, inst, conn, act, run, NULL, NULL, NULL, clean };

const LADSPA_Descriptor *ladspa_descriptor(unsigned long i) { return i == 0 ? &desc : NULL; }
