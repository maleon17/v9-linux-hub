'use strict';
// V9 Linux Hub: неофициальное Linux-приложение для гарнитуры MCHOSE V9 Pro.
// Интерфейс — веб-фронтенд производителя (версия 1.1.26), который скачивается с его CDN на машину пользователя
// (frontend/manifest.json); main-процесс, звуковой движок на PipeWire и мост к оборудованию — свои.
const { app, BrowserWindow, ipcMain, protocol, session, net, screen, shell, nativeTheme, Tray, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./lib/store.cjs');
const { Sdk } = require('./lib/sdk.cjs');
const audio = require('./lib/audio.cjs');
const { Dsp } = require('./lib/dsp.cjs');

const ROOT = __dirname;
const APP_NAME = 'V9 Linux Hub', APP_ID = 'v9-linux-hub';
const RENDERER_URL = 'mchose-renderer://app/cdn.mchose.com.cn/customPage/prod/index.html?v=1.1.26';
const HID_VENDORS = new Set([0x291d]);           // ресивер MCHOSE V9 Pro
const MIN_W = 720, MIN_H = 520;   // при 720 облако в шапке как раз доезжает до лампочки; уже — правая панель наезжает на иконки
const DEBUG = process.argv.includes('--debug') || process.env.MHUB_DEBUG === '1';
const OFFLINE = process.argv.includes('--offline');
const BOOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'boot.json'), 'utf8'));

const log = (...a) => { if (DEBUG) console.log('[v9hub]', ...a); };

app.setName(APP_NAME);
app.setPath('userData', process.env.MHUB_PROFILE || path.join(app.getPath('appData'), APP_ID));
// Перенос данных из ранних версий (папка «M HUB»)
try {
  const old = path.join(app.getPath('appData'), 'M HUB'), cur = app.getPath('userData');
  if (!process.env.MHUB_PROFILE && fs.existsSync(old) && !fs.existsSync(cur)) fs.cpSync(old, cur, { recursive: true });
} catch {}
const UI = path.join(app.getPath('userData'), 'frontend');
const NO_DSP = process.env.MHUB_NO_DSP === '1';
const HIDDEN = process.argv.includes('--hidden');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
app.on('second-instance', () => showWindow());
let quitting = false, tray = null;
app.commandLine.appendSwitch('enable-features', 'WebHID');
protocol.registerSchemesAsPrivileged([{
  scheme: 'mchose-renderer',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
};

// Локальная копия https://<host>/<path>; недостающее качаем и кладём рядом (дальше работает офлайн).
function localFile(host, pathname) {
  let p = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!p || p.endsWith('/')) p += '__index__';
  const f = path.normalize(path.join(UI, host, p));
  return f.startsWith(UI + path.sep) ? f : null;
}

async function serveCached(host, pathname, request) {
  const f = localFile(host, pathname);
  if (f && fs.existsSync(f) && fs.statSync(f).isFile()) {
    const ext = path.extname(f).toLowerCase();
    return new Response(fs.readFileSync(f), {
      headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' },
    });
  }
  if (OFFLINE) return new Response('offline', { status: 404 });
  const url = `https://${host}${pathname}`;
  try {
    const res = await net.fetch(url, { method: request?.method || 'GET', bypassCustomProtocolHandlers: true });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.ok && f && (request?.method || 'GET') === 'GET') {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, buf);
      log('cached', url);
    }
    const headers = new Headers(res.headers);
    headers.set('access-control-allow-origin', '*');
    return new Response(buf, { status: res.status, headers });
  } catch (e) {
    log('fetch failed', url, e.message);
    return new Response('', { status: 502 });
  }
}

function setupSession(ses) {
  ses.protocol.handle('mchose-renderer', req => {
    const u = new URL(req.url);                       // mchose-renderer://app/<host>/<path>
    const [, host, ...rest] = u.pathname.split('/');
    return serveCached(host, '/' + rest.join('/'), req);
  });
  // Ресурсы CDN MCHOSE — из локальной копии; всё остальное идёт в сеть как есть.
  ses.protocol.handle('https', req => {
    const u = new URL(req.url);
    if (u.hostname === 'cdn.mchose.com.cn') return serveCached(u.hostname, u.pathname, req);
    return net.fetch(req, { bypassCustomProtocolHandlers: true });
  });

  // Отладочные/внутренние адреса разработчиков MCHOSE (LAN) — отклоняем сразу, иначе фронтенд ждёт таймаут.
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, cb) => {
    const h = new URL(details.url).hostname;
    const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost$|127\.)/.test(h);
    cb({ cancel: lan });
  });

  // Отладка: какие хосты реально запрашиваются (для раздела «Сеть» в README)
  if (DEBUG) ses.webRequest.onCompleted({ urls: ['https://*/*', 'http://*/*'] }, d => log('net', d.method, new URL(d.url).host, d.statusCode, d.fromCache ? 'cache' : ''));

  // WebHID: только ресивер гарнитуры
  ses.setPermissionCheckHandler((_wc, perm) => perm === 'hid' || perm === 'clipboard-sanitized-write' || perm === 'media');
  ses.setDevicePermissionHandler(d => d.deviceType === 'hid' && HID_VENDORS.has(d.device.vendorId));
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const dev = details.deviceList.find(d => HID_VENDORS.has(d.vendorId));
    log('select-hid-device', details.deviceList.map(d => `${d.vendorId.toString(16)}:${d.productId.toString(16)} ${d.name}`));
    callback(dev ? dev.deviceId : '');
  });
}

// Радиус скругления окна в оконном менеджере (Hyprland decoration:rounding), чтобы панели совпадали с углами окна
let _wmRadius = null;
function wmRadius() {
  if (_wmRadius != null) return _wmRadius;
  _wmRadius = 32;
  try {
    const out = require('node:child_process').execFileSync('hyprctl', ['getoption', 'decoration:rounding', '-j'], { timeout: 1500 }).toString();
    const v = JSON.parse(out).int; if (Number.isFinite(v)) _wmRadius = v;
  } catch {}
  return _wmRadius;
}

function desktopEntry(args = []) {
  return `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nGenericName=Headset settings\nComment=Unofficial settings app for the MCHOSE V9 Pro headset\n` +
    `Exec="${path.join(ROOT, 'v9hub')}" ${args.join(' ')}\nIcon=${path.join(ROOT, 'assets', 'icon.png')}\n` +
    `Terminal=false\nCategories=AudioVideo;Audio;Settings;HardwareSettings;\nStartupWMClass=${APP_NAME}\n`;
}

// ---------- окно ----------
let win = null;
function windowState() {
  if (!win || win.isDestroyed()) return { windowId: 'main', visible: false };
  return { windowId: 'main', visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1440, wa.width), height: Math.min(810, wa.height), minWidth: MIN_W, minHeight: MIN_H,
    frame: false, transparent: true, backgroundColor: '#00000000', show: false, title: APP_NAME, hasShadow: false,
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'lib', 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => { if (!HIDDEN) win.show(); });
  win.on('close', e => {
    if (!quitting && store?.getConfig('system').hideWhenClose !== false) { e.preventDefault(); win.hide(); }
  });
  const sendState = () => win && !win.isDestroyed() && win.webContents.send('windowStateChange', windowState());
  for (const ev of ['maximize', 'unmaximize', 'minimize', 'restore', 'focus', 'blur', 'show', 'hide']) {
    win.on(ev, () => { sendState(); if (ev === 'maximize' || ev === 'unmaximize') win.webContents.send(ev); });
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (DEBUG) win.webContents.on('console-message', (_e, level, msg, line, src) => level >= 2 && log('console', level, msg.slice(0, 300), src, line));
  // Слой Linux-адаптации интерфейса (ui-linux.css/js); в режиме отладки — горячая перезагрузка
  let cssKey = null;
  const injectUi = async () => {
    if (!win || win.isDestroyed()) return;
    try {
      const wc = win.webContents;
      if (cssKey) await wc.removeInsertedCSS(cssKey).catch(() => {});
      cssKey = await wc.insertCSS(`:root{--mhub-wm-radius:${wmRadius()}px}\n` + fs.readFileSync(path.join(ROOT, 'lib', 'ui-linux.css'), 'utf8'));
      await wc.executeJavaScript(fs.readFileSync(path.join(ROOT, 'lib', 'ui-linux.js'), 'utf8'));
    } catch (e) { log('ui-linux', e.message); }
  };
  win.webContents.on('dom-ready', () => { cssKey = null; injectUi(); });
  // наблюдаем за папкой: редакторы и sed -i подменяют файл, и наблюдение за самим файлом теряется
  if (DEBUG) fs.watch(path.join(ROOT, 'lib'), (_ev, f) => { if (/^ui-linux\.(css|js)$/.test(f || '')) { clearTimeout(win?._uiT); if (win) win._uiT = setTimeout(injectUi, 80); } });
  loadFrontend();
  win.on('closed', () => { win = null; });
}

// Фронтенд: при первом запуске (или если чего-то не хватает) — заставка с прогрессом и загрузка по списку
async function loadFrontend() {
  const manifest = require('./frontend/manifest.json');
  const { ensure, missing } = require('./lib/frontend.cjs');
  if (!OFFLINE && missing(UI, manifest).length) {
    await win.loadFile(path.join(ROOT, 'assets', 'splash.html'));
    if (!HIDDEN) win.show();
    const fetchBuf = async url => { const r = await net.fetch(url, { bypassCustomProtocolHandlers: true }); if (!r.ok) throw new Error('HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); };
    const res = await ensure(UI, manifest, fetchBuf, {
      log, onProgress: (d, t) => win?.webContents.executeJavaScript(`window.progress?.(${d}, ${t})`).catch(() => {}),
    });
    if (res.failed.length) log('frontend: не скачано', res.failed.length);
  }
  win?.loadURL(RENDERER_URL);
}

// ---------- IPC ----------
let store, sdk, dsp;
const handled = new Set();
function handle(ch, fn) {
  handled.add(ch);
  ipcMain.handle(ch, async (e, ...a) => {
    const r = await fn(e, ...a);
    if (DEBUG && !/Volume|Mute|^log/.test(ch)) log('ipc', ch, JSON.stringify(a).slice(0, 120), '=>', JSON.stringify(r)?.slice(0, 160));
    return r;
  });
}

function registerIpc() {
  // Приложение и окружение
  handle('getVersion', () => BOOT.getVersion);
  handle('getEnv', () => 'production');
  handle('getCurEnv', () => 'production');
  handle('setCurEnv', () => true);
  handle('getTargetEnvConfig', () => BOOT.getTargetEnvConfig);
  handle('getEnvConfigs', () => BOOT.getEnvConfigs);
  handle('getRendererBuildInfo', () => ({ buildEnv: 'production', canUpdate: false }));
  handle('getMainFlags', () => ({ isShowedUpdateResultToast: false, updaterApplyResult: null, firstTriggeredReadyToShow: true }));
  handle('setMainFlags', () => true);
  handle('getArgv', () => process.argv);
  handle('getStartupPresentationState', () => ({ phase: 'released' }));
  handle('renderer:report-ready', () => ({ ok: true }));
  handle('renderer:get-url', () => RENDERER_URL);
  handle('renderer:get-fallback-context', () => ({ reason: 'fallback' }));
  handle('renderer:refresh-global', () => ({ globalConfigAvailable: true }));
  handle('renderer:probe-reachable', () => ({ reachable: true, method: 'head' }));
  handle('renderer:retry-load', () => { setTimeout(() => win?.loadURL(RENDERER_URL), 50); return { accepted: true }; });
  handle('renderer:sync-device-config', (_e, m = {}) => ({ success: true, count: Object.keys(m || {}).length }));
  handle('vc-redist:check-x64', () => ({ available: true, reason: 'linux', version: null }));
  handle('getIsAdminRunning', () => true);   // на Linux права не нужны; иначе фронтенд показывает «требуются права администратора»
  handle('isInstalledInSystemDrive', () => true);
  handle('getAppMetrics', () => app.getAppMetrics());
  handle('updater:getState', () => ({ status: 'idle' }));
  for (const ch of ['logInfo', 'logWarn', 'logError', 'appendFilesLog']) handle(ch, (_e, msg) => { log(ch, String(msg).slice(0, 300)); return true; });

  // Язык и тема
  const sys = () => store.getConfig('system');
  handle('getLang', () => sys().lang || 'en_US');
  handle('getDefaultLang', () => sys().lang || 'en_US');
  handle('setMainLang', (_e, lang) => { store.setConfig('system', { lang }); return true; });
  handle('getThemeValue', () => sys().theme || 'light');
  handle('getWindowsTheme', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
  // Автозапуск: XDG autostart (~/.config/autostart), запуск сразу в трей
  const AUTOSTART = path.join(app.getPath('home'), '.config', 'autostart', APP_ID + '.desktop');
  handle('getAutoStartStatus', () => fs.existsSync(AUTOSTART));
  handle('setAutoStart', (_e, v) => {
    try {
      if (v) {
        fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
        fs.writeFileSync(AUTOSTART, desktopEntry(['--hidden']) + 'X-GNOME-Autostart-enabled=true\n');
      } else if (fs.existsSync(AUTOSTART)) fs.unlinkSync(AUTOSTART);
      store.setConfig('system', { autoStart: !!v });
      return { success: true };
    } catch (e) { return { success: false, msg: e.message }; }
  });
  handle('getSharedConfig', () => BOOT.getSharedConfig);
  handle('setSharedConfig', () => undefined);

  // Окно
  handle('getScreenInfo', () => {
    const d = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
    return { width: d.workAreaSize.width, height: d.workAreaSize.height, scaleFactor: d.scaleFactor, isBeyondScreen: false };
  });
  handle('closeWindow', () => { win?.close(); return true; });   // close -> трей (hideWhenClose)
  handle('hideWindow', () => { win?.hide(); return true; });
  handle('minimizeWindow', () => { win?.minimize(); return true; });
  handle('maximizeWindow', () => { win?.maximize(); return true; });
  handle('unmaximize', () => { win?.unmaximize(); return true; });
  handle('toggleMax', () => { if (!win) return false; win.isMaximized() ? win.unmaximize() : win.maximize(); return win.isMaximized(); });
  handle('isMaximized', () => !!win?.isMaximized());
  handle('isWindowVisible', () => !!win?.isVisible());
  handle('getWindowStateSnapshot', () => windowState());
  handle('getWindowSize', () => { const [width, height] = win ? win.getSize() : [1440, 810]; return { width, height }; });
  handle('setWindowSize', (_e, w, h) => { win?.setSize(Math.round(w), Math.round(h)); return true; });
  // Фронтенд просит минимум 1440×800 (как в Windows). На Linux окно может быть плиткой в пол-экрана — не ограничиваем.
  handle('setWindowMInSize', () => { win?.setMinimumSize(MIN_W, MIN_H); return true; });
  handle('setZoomFactor', (_e, f) => { win?.webContents.setZoomFactor(Number(f) || 1); return true; });
  handle('setBounds', (_e, x, y, w, h) => { win?.setBounds({ x, y, width: w, height: h }); return true; });
  handle('setPosition', (_e, x, y) => { win?.setPosition(Math.round(x), Math.round(y)); return true; });
  handle('getDragBoundsAndRestoreIfMaximized', (_e, x = 0, y = 0) => {
    const wasRestored = !!win?.isMaximized();
    if (wasRestored) win.unmaximize();
    return { bounds: win?.getBounds() ?? { x, y, width: 1440, height: 810 }, wasRestored };
  });
  handle('windowManager', (_e, p = {}) => (p.method === 'getWindowState' ? { status: 'active' } : p.method === 'closeWindow' ? { success: true } : {}));
  handle('createTrayWindow', () => ({ success: true }));
  handle('customTray', () => undefined);
  handle('showOpenFileDialog', async (_e, opts = {}) => require('electron').dialog.showOpenDialog(win, opts));
  handle('openDevTools', () => { win?.webContents.openDevTools({ mode: 'detach' }); return true; });
  handle('openBrowser', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); return true; });
  handle('openSoundSetting', () => { require('node:child_process').spawn('pavucontrol', { detached: true, stdio: 'ignore' }).on('error', () => {}); return true; });
  handle('quit', () => { quitting = true; app.quit(); return true; });

  // Хранилища
  handle('getStore', (_e, k, d) => store.get(k, d));
  handle('setStore', (_e, k, v) => store.set(k, v));
  handle('hasStore', (_e, k) => store.has(k));
  handle('deleteStore', (_e, k) => store.delete(k));
  handle('clearStore', () => store.clear());
  handle('getAllStore', () => store.all());
  handle('watchAllStore', e => store.watch(e.sender));
  handle('unwatchAllStore', (_e, id) => store.unwatch(id));
  handle('getConfig', (_e, name) => store.getConfig(name));
  handle('setConfig', (_e, name, data) => store.setConfig(name, data));
  handle('getUserConfig', () => ({ token: '', nickname: null, headimgurl: null, ...(store.get('user_config').value || {}) }));
  handle('setUserConfig', (_e, c = {}) => { const v = { ...(store.get('user_config').value || {}), ...c }; store.set('user_config', v); return v; });
  handle('getLegacyRendererLocalStorage', () => null);
  handle('getLegacyHttpsLocalStorage', () => null);
  handle('getLegacyHttpsIndexedDB', () => null);
  handle('migrateLegacyUrlIndexIframeStorage', () => ({ skipped: true, markedComplete: true, localStorage: null, indexedDB: null }));
  handle('getLegacyK20GtCustomImageHistory', () => null);
  for (const ch of ['getUsbDeviceDescriptor', 'getFWVersionFromUsbDescriptor', 'getUsbStringDescriptor', 'getUsbVersion'])
    handle(ch, () => ({ code: -1, err: 'linux: not available', candidates: [] }));
  handle('getFirmwareVer', () => '');
  handle('getBgImg', () => false);
  handle('getGifImgList', () => []);
  handle('scanAppList', () => []);
  handle('scanGameList', () => []);
  handle('getExeDetailInfo', () => ({}));
  handle('isLyricsMonitorRunning', () => false);
  handle('updater:startSilentDownload', () => ({ status: 'skipped', reason: 'linux' }));
  handle('updater:startManualUpdate', () => ({ status: 'skipped', reason: 'linux' }));
  handle('updater:applyDownloadedUpdateNow', () => ({ started: false, skipped: true, reason: 'linux' }));
  handle('localFiles:getRoot', () => path.join(app.getPath('userData'), 'files', 'local'));
  handle('localFiles:list', () => []);
  handle('localFiles:exists', () => false);
  handle('localFiles:read', () => null);

  // Аудио SDK (C-Media) -> Linux
  const sdkState = () => ({ success: true, ready: true, sdkType: 'cmedia_2025', platform: 'linux', sessions: [{ deviceId: sdk.deviceId }] });
  handle('audio-sdk:get-state', sdkState);
  handle('audio-sdk:install-driver', (_e, o = {}) => ({ success: true, installSucceeded: true, data: { productKey: o.productKey ?? null, driverDir: o.driverDir ?? null, infCount: 0, failedCount: 0, elapsedMs: 0, results: [], skipped: true, skipReason: 'linux-pipewire' } }));
  handle('audio-sdk:ensure-ready', (_e, r = {}) => ({ success: true, deviceId: r.deviceId ?? sdk.deviceId, readyInfo: { sdkType: r.sdkType ?? 'cmedia_2025', dllPath: 'pipewire', guid: r.guid ?? null, productKey: r.productKey ?? null } }));
  handle('audio-sdk:release-device', (_e, id) => ({ success: true, deviceId: id ?? null }));
  handle('audio-sdk:call', (_e, { method, args } = {}) => sdk.call(method, args));
  handle('initDll', () => true);
  // Одноимённые прямые каналы (без deviceId)
  const direct = ['getVolumeScalarControl', 'setVolumeScalarControl', 'getMuteControl', 'setMuteControl', 'getAINREnable', 'setAINREnable',
    'getEnable_AUDIOBRILLIANT_LFX', 'setEnable_AUDIOBRILLIANT_LFX', 'getAUDIOBRILLIANT_LEVEL', 'setAUDIOBRILLIANT_LEVEL',
    'getVIRTUALBASS_CutOffFrequency', 'setVIRTUALBASS_CutOffFrequency', 'getEnable_VIRTUALBASS_LFX', 'setEnable_VIRTUALBASS_LFX',
    'getVIRTUALBASS_Level', 'setVIRTUALBASS_Level', 'getEnable_ADAPTIVEVOLUME_GFX', 'setEnable_ADAPTIVEVOLUME_GFX',
    'getADAPTIVEVOLUME_LEVEL', 'setADAPTIVEVOLUME_LEVEL', 'getADAPTIVEVOLUME_MODE', 'setADAPTIVEVOLUME_MODE', 'GetEnable_EQ_GFX',
    'setEnable_EQ_GFX', 'getEQ_Slider', 'setEQ_Slider', 'getEnable_MAGICVOICE', 'setEnable_MAGICVOICE', 'getMagicVoice_Selection',
    'setMagicVoice_Selection', 'getEnable_VOICECLARITY_LFX', 'setEnable_VOICECLARITY_LFX', 'getVOICECLARITY_LEVEL', 'setVOICECLARITY_LEVEL',
    'getVOICECLARITY_NOISESUPP_LEVEL', 'setVOICECLARITY_NOISESUPP_LEVEL', 'getNR_Enable', 'setNR_Enable', 'getEnable_Channel_COPY_LFX',
    'setEnable_Channel_COPY_LFX', 'getXearSurroundEnable', 'setXearSurroundEnable', 'getXearSurroundMode', 'setXearSurroundMode',
    'getXearSurroundRoom', 'setXearSurroundRoom', 'getDeviceFriendlyName', 'setToDefault'];
  for (const ch of direct) handle(ch, async (_e, ...a) => (await sdk.call(ch, [sdk.deviceId, ...a])).data);
  handle('playTestSound', (_e, v) => dsp.testSpeaker(v));
  handle('stopTestSound', () => dsp.stopTestSound());
  handle('getMicListenStatus', () => (dsp.micMonitor ? [{ deviceFriendlyName: 'Mic (MCHOSE V9 PRO)', status: true }] : []));
  handle('setMicListenStatus', (_e, p = {}) => dsp.setMicMonitor(!!p.status));
  handle('getAudioVolume', async (_e, p = {}) => Math.round(((await audio.getVolume(p.type === 'mic' ? 'mic' : 'speaker')) ?? 0) * 100));
  handle('setAudioVolume', async (_e, p = {}) => { await audio.setVolume(p.type === 'mic' ? 'mic' : 'speaker', (p.value ?? p.volume ?? 0) / 100); return true; });
  handle('getAudioMute', async (_e, p = {}) => (await audio.getMute(p.type === 'mic' ? 'mic' : 'speaker')) ?? false);
  handle('setAudioMute', async (_e, p = {}) => { await audio.setMute(p.type === 'mic' ? 'mic' : 'speaker', !!(p.mute ?? p.value)); return true; });
  let unwatch = null;
  handle('startWatchAudioVolume', e => {
    if (!unwatch) unwatch = audio.watch(ch => {
      if (e.sender.isDestroyed()) return;
      e.sender.send('callbackVOLUMEANDMUTE');
      e.sender.send('onAudioVolumeChange', ch);
    });
    return undefined;
  });
  handle('stopWatchAudioVolume', () => { unwatch?.(); unwatch = null; return undefined; });

  // Свои настройки Linux-версии: профиль HRTF, тип тестового звука
  const LS = path.join(app.getPath('userData'), 'linux.json');
  const linuxGet = () => { try { return { hrtf: 'sadie-d2', testSound: 'steps', ...JSON.parse(fs.readFileSync(LS, 'utf8')) }; } catch { return { hrtf: 'sadie-d2', testSound: 'steps' }; } };
  handle('linux:get', () => linuxGet());
  handle('linux:set', (e, patch = {}) => {
    const v = { ...linuxGet(), ...patch }; fs.writeFileSync(LS, JSON.stringify(v, null, 1));
    if (patch.hrtf) dsp.setHrtf(patch.hrtf);
    if (patch.testSound) dsp.testKind = patch.testSound;
    e.sender.send('linux:changed', v); return v;
  });
  let prefetch = null;
  handle('linux:hrtf-list', () => {
    const list = dsp.hrtf.list(dsp.hrtfId), cur = list.find(x => x.id === dsp.hrtfId);
    if (cur && !cur.ready) dsp.hrtf.ensure(cur.id).catch(e => log('HRTF', e.message));   // готовим заранее
    // Остальные профили списка — фоном по одному (один раз за сеанс), чтобы переключение было мгновенным
    if (!prefetch) prefetch = list.filter(x => !x.ready && x !== cur).reduce((p, x) => p.then(() => dsp.hrtf.ensure(x.id).catch(e => log('HRTF', x.id, e.message))), Promise.resolve());
    return list;
  });
  handle('linux:test-play', (_e, kind, speaker) => dsp.playDemo(kind || linuxGet().testSound, speaker));
  handle('linux:test-stop', () => dsp.stopDemo());
  dsp.hrtfId = linuxGet().hrtf;
  dsp.testKind = linuxGet().testSound;

  // Все прочие каналы из оригинального preload: безопасная заглушка (Windows-специфика, аккаунт, OTA и т.п.)
  const manifest = require('./lib/api-manifest.json');
  const channels = new Set([...Object.values(manifest.invoke), 'audio-sdk:call']);
  for (const ch of channels) if (!handled.has(ch)) ipcMain.handle(ch, (_e, ...a) => { log('stub', ch, JSON.stringify(a).slice(0, 160)); return null; });
}

app.whenReady().then(() => {
  const dataDir = path.join(app.getPath('userData'), 'files', 'config');
  store = new Store(dataDir, path.join(ROOT, 'seed'));
  dsp = new Dsp({ dataDir: app.getPath('userData'), root: ROOT, log });
  sdk = new Sdk({ store, dsp, log });
  setupSession(session.defaultSession);
  registerIpc();
  if (!NO_DSP) dsp.start(sdk.state).catch(e => console.error('[v9hub] DSP:', e.message));
  createWindow();
  try { createTray(); } catch (e) { log('tray', e.message); }
});

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'icon.png')).resize({ width: 22, height: 22 }));
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть', click: showWindow },
    { type: 'separator' },
    { label: 'Выход', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

app.on('window-all-closed', () => { /* остаёмся в трее: DSP продолжает работать */ });
app.on('before-quit', () => { quitting = true; store?.flushAll(); dsp?.stop(); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { quitting = true; app.quit(); });
