const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const http = require('node:http');

const PORT_API = 3210;
const PORT_OVERLAY = 5173;
const PORT_ADMIN = 5200;
const PORT_TTS = 9881;
const PORT_MUSETALK = 9898;
const PORT_ACCENT = 9899;

// 定位运行根：
//  - 打包：exe 同级的 app/（MEIHUA_STUDIO_ROOT=exe 目录）
//  - 开发：仓库根（apps/desktop 的上级）
function resolveBundleRoot() {
  const candidates = [
    process.env.MEIHUA_STUDIO_ROOT,
    dirname(dirname(process.execPath)),
    resolve(__dirname, '..', '..', '..'),
    resolve(__dirname, '..', '..'),
  ].filter(Boolean);
  return candidates.find((candidate) => (
    existsSync(join(candidate, 'app', 'apps', 'orchestrator', 'dist', 'index.cjs'))
    || existsSync(join(candidate, 'apps', 'orchestrator'))
  )) || resolve(__dirname, '..', '..');
}

const BUNDLE_ROOT = resolveBundleRoot();
const APP_ROOT = existsSync(join(BUNDLE_ROOT, 'app')) ? join(BUNDLE_ROOT, 'app') : BUNDLE_ROOT;
const NODE_EXE = process.env.MEIHUA_NODE_EXE
  || (existsSync(join(BUNDLE_ROOT, 'runtime', 'node', 'node.exe')) ? join(BUNDLE_ROOT, 'runtime', 'node', 'node.exe') : process.execPath === 'electron.exe' ? '' : resolve(__dirname, '..', '..', 'node_modules', '.bin', 'node.cmd'));
const NODE_PROGRAM = process.platform === 'win32' && !process.execPath.endsWith('.exe') ? undefined : NODE_EXE;

let mainWindow = null;
let tray = null;
const children = [];
const LOG_DIR = join(BUNDLE_ROOT, 'logs');
const LOG_FILE = join(LOG_DIR, 'desktop-launcher.log');

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function resolveGpuRuntimeProfile() {
  const allowed = new Set(['CPU_COMPAT', 'SAFE_8GB', 'STANDARD_12GB', 'ENHANCED_16GB']);
  const requested = String(process.env.MEIHUA_GPU_PROFILE || '').trim().toUpperCase();
  let gpuName = String(process.env.MEIHUA_GPU_NAME || '').trim();
  let vramMb = positiveInteger(process.env.MEIHUA_GPU_VRAM_MB);
  let freeVramMb = positiveInteger(process.env.MEIHUA_GPU_FREE_MB);

  if (!vramMb) {
    try {
      const line = String(execFileSync(
        process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi',
        ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'],
        { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
      )).split(/\r?\n/).find(Boolean);
      const [name, total, free] = String(line || '').split(',').map((part) => part.trim());
      gpuName = gpuName || name || '';
      vramMb = positiveInteger(total);
      freeVramMb = positiveInteger(free);
    } catch { /* no NVIDIA driver or nvidia-smi unavailable: CPU profile */ }
  }

  const id = allowed.has(requested)
    ? requested
    : !vramMb
      ? 'CPU_COMPAT'
      : vramMb <= 8192
        ? 'SAFE_8GB'
        : vramMb <= 12288
          ? 'STANDARD_12GB'
          : 'ENHANCED_16GB';
  const settings = {
    CPU_COMPAT: { batch: 1, width: 540, height: 960, prebuffer: 0, releaseVoiceGpu: '0' },
    SAFE_8GB: { batch: 1, width: 720, height: 1280, prebuffer: 0, releaseVoiceGpu: '1' },
    STANDARD_12GB: { batch: 2, width: 900, height: 1600, prebuffer: 1, releaseVoiceGpu: '1' },
    ENHANCED_16GB: { batch: 4, width: 1080, height: 1920, prebuffer: 2, releaseVoiceGpu: '1' },
  }[id];
  return {
    id,
    gpuName,
    vramMb,
    freeVramMb,
    environment: {
      MEIHUA_GPU_PROFILE: id,
      MEIHUA_GPU_VRAM_MB: String(vramMb),
      ...(gpuName ? { MEIHUA_GPU_NAME: gpuName } : {}),
      ...(freeVramMb ? { MEIHUA_GPU_FREE_MB: String(freeVramMb) } : {}),
      MUSETALK_BATCH_SIZE: String(settings.batch),
      MEIHUA_AVATAR_MAX_WIDTH: String(settings.width),
      MEIHUA_AVATAR_MAX_HEIGHT: String(settings.height),
      MEIHUA_DIGITAL_HUMAN_PREBUFFER_SEGMENTS: String(settings.prebuffer),
      MEIHUA_RELEASE_GPU_AFTER_TTS: settings.releaseVoiceGpu,
    },
  };
}

const GPU_RUNTIME = resolveGpuRuntimeProfile();

function runtimeEnvironment(overrides = {}) {
  return {
    ...process.env,
    // A Windows system code page must not be able to kill real TTS merely
    // because a model prints Chinese progress information into a log pipe.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...GPU_RUNTIME.environment,
    ...overrides,
  };
}

function log(message) {
  const line = `[desktop ${new Date().toLocaleTimeString()}] ${message}`;
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG_FILE, `${line}\n`, 'utf8'); } catch { /* logging must never block startup */ }
  // eslint-disable-next-line no-console
  console.log(line);
}

function token() {
  const path = join(APP_ROOT, 'data', 'runtime-control-token');
  try { return readFileSync(path, 'utf8').trim(); } catch { return ''; }
}

function healthCheck() {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: '127.0.0.1', port: PORT_API, path: '/api/health', timeout: 1500, headers: { 'x-meihua-token': token() } }, (res) => {
      try {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => { const data = JSON.parse(body); resolvePromise(Boolean(data && (data.currentStage || data.uptimeMs || true))); });
      } catch { resolvePromise(false); }
    });
    req.on('error', () => resolvePromise(false));
    req.on('timeout', () => { req.destroy(); resolvePromise(false); });
  });
}

async function waitHealth(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await healthCheck()) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

function resolveNode() {
  if (process.env.MEIHUA_NODE_EXE) return process.env.MEIHUA_NODE_EXE;
  const bundled = join(BUNDLE_ROOT, 'runtime', 'node', 'node.exe');
  if (existsSync(bundled)) return bundled;
  // 开发模式：用系统 node 跑 orchestrator（tsx 或 dist）
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function startOrchestrator() {
  const entry = join(APP_ROOT, 'apps', 'orchestrator', 'dist', 'index.cjs');
  const useTsx = !existsSync(entry);
  const child = spawn(
    useTsx && process.env.MEIHUA_DEV ? resolveNode() : resolveNode(),
    useTsx
      ? [join(APP_ROOT, 'node_modules', '.bin', 'tsx'), join(APP_ROOT, 'apps', 'orchestrator', 'src', 'index.ts')]
      : [entry],
    {
      cwd: APP_ROOT,
      env: runtimeEnvironment({
        MEIHUA_PRODUCTION: '1',
        MEIHUA_PROJECT_ROOT: APP_ROOT,
        HOST: '0.0.0.0',
        ADMIN_PORT: String(PORT_ADMIN),
        OVERLAY_PORT: String(PORT_OVERLAY),
        PORT: String(PORT_API),
      }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  child.stdout?.on('data', (chunk) => log(`[中控] ${String(chunk).trim()}`));
  child.stderr?.on('data', (chunk) => log(`[中控/err] ${String(chunk).trim()}`));
  child.on('exit', (code) => log(`中控进程退出 code=${code}`));
  return child;
}

function startGptSoVits() {
  const roots = [join(BUNDLE_ROOT, 'gptsovits'), resolve(BUNDLE_ROOT, '..', 'V3音色包')];
  const root = roots.find((candidate) => existsSync(join(candidate, 'runtime', 'python.exe')) && existsSync(join(candidate, 'api_v3.py')));
  const python = root ? join(root, 'runtime', 'python.exe') : '';
  const api = root ? join(root, 'api_v3.py') : '';
  if (!existsSync(python) || !existsSync(api)) { log('未检测到 GPT-SoVITS，跳过声音克隆服务'); return null; }
  const ffmpegDir = existsSync(join(APP_ROOT, 'tools', 'ffmpeg')) ? join(APP_ROOT, 'tools', 'ffmpeg') : join(BUNDLE_ROOT, 'app', 'tools', 'ffmpeg');
  const child = spawn(python, [api, '-a', '127.0.0.1', '-p', String(PORT_TTS)], {
    cwd: root,
    env: runtimeEnvironment({
      PATH: `${ffmpegDir};${process.env.PATH || ''}`,
      FFMPEG_BINARY: join(ffmpegDir, 'ffmpeg.exe'),
      MEIHUA_FFMPEG_PATH: ffmpegDir,
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (chunk) => log(`[声音] ${String(chunk).trim()}`));
  child.stderr?.on('data', (chunk) => log(`[声音/err] ${String(chunk).trim()}`));
  child.on('exit', (code) => log(`声音服务退出 code=${code}`));
  return child;
}

function startMuseTalk() {
  const roots = [join(BUNDLE_ROOT, 'musetalk'), resolve(BUNDLE_ROOT, '..', 'MuseTalk')];
  const root = roots.find((candidate) => existsSync(join(candidate, 'scripts', 'realtime_inference.py')));
  const pythonCandidates = [
    join(BUNDLE_ROOT, 'gptsovits', 'runtime', 'python.exe'),
    resolve(BUNDLE_ROOT, '..', 'V3音色包', 'runtime', 'python.exe'),
  ];
  const python = pythonCandidates.find((candidate) => existsSync(candidate));
  const service = join(APP_ROOT, 'services', 'musetalk-service', 'main.py');
  if (!root || !python || !existsSync(service)) {
    log('未检测到完整 MuseTalk 运行包，跳过视频数字人服务');
    return null;
  }
  const packages = join(root, '.python-packages');
  const ffmpegDir = join(APP_ROOT, 'tools', 'ffmpeg');
  const pythonPath = [packages, root, join(root, 'musetalk', 'utils'), process.env.PYTHONPATH || ''].filter(Boolean).join(';');
  const child = spawn(python, [service, '--host', '127.0.0.1', '--port', String(PORT_MUSETALK)], {
    cwd: root,
    env: runtimeEnvironment({
      MUSETALK_HOME: root,
      MUSETALK_PYTHON: python,
      MUSETALK_PYTHONPATH: packages,
      MEIHUA_FFMPEG_PATH: ffmpegDir,
      PYTHONPATH: pythonPath,
      PATH: `${ffmpegDir};${process.env.PATH || ''}`,
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (chunk) => log(`[数字人] ${String(chunk).trim()}`));
  child.stderr?.on('data', (chunk) => log(`[数字人/err] ${String(chunk).trim()}`));
  child.on('exit', (code) => log(`数字人服务退出 code=${code}`));
  return child;
}

function startVoiceAccent() {
  const roots = [join(BUNDLE_ROOT, 'openvoice'), resolve(BUNDLE_ROOT, '..', 'OpenVoice')];
  const pythonCandidates = [
    join(BUNDLE_ROOT, 'gptsovits', 'runtime', 'python.exe'),
    resolve(BUNDLE_ROOT, '..', 'V3音色包', 'runtime', 'python.exe'),
  ];
  const python = pythonCandidates.find((candidate) => existsSync(candidate));
  const service = join(APP_ROOT, 'services', 'voice-accent', 'main.py');
  if (!python || !existsSync(service)) {
    log('未检测到目标口音服务运行时，跳过本地口音服务');
    return null;
  }
  const accentHome = roots.find((candidate) => existsSync(candidate)) || roots[0];
  const child = spawn(python, [service, '--host', '127.0.0.1', '--port', String(PORT_ACCENT)], {
    cwd: APP_ROOT,
    env: runtimeEnvironment({
      MEIHUA_ACCENT_HOME: accentHome,
      PYTHONPATH: [process.env.PYTHONPATH || ''].filter(Boolean).join(';'),
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout?.on('data', (chunk) => log(`[目标口音] ${String(chunk).trim()}`));
  child.stderr?.on('data', (chunk) => log(`[目标口音/err] ${String(chunk).trim()}`));
  child.on('exit', (code) => log(`目标口音服务退出 code=${code}`));
  return child;
}

function localServiceReady(port, path = '/health') {
  return new Promise((resolvePromise) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 1_500 }, (res) => {
      res.resume();
      resolvePromise(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
    });
    req.on('error', () => resolvePromise(false));
    req.on('timeout', () => { req.destroy(); resolvePromise(false); });
  });
}

function stopChildren() {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  children.length = 0;
}

// ── TikFinity 直播事件采集（外挂依赖，自动拉起）──
// TikTok 没有开放的直播事件 API，抓取礼物/点赞必须由登录态的 TikFinity Desktop 维持连接；
// 中控只连它的本地 ws://127.0.0.1:21213。这里负责"确保它开着"：已运行则跳过，未运行则拉起。
function findTikFinityExe() {
  const candidates = [
    join(BUNDLE_ROOT, 'tikfinity', 'TikFinity.exe'),
    join(process.env.LOCALAPPDATA || '', 'Programs', 'tikfinity', 'TikFinity.exe'),
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'tikfinity', 'TikFinity.exe'),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function isTikFinityRunning() {
  try {
    const output = require('node:child_process').execSync(
      'tasklist /FI "IMAGENAME eq TikFinity.exe" /FO CSV /NH',
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    );
    return /TikFinity\.exe/i.test(String(output));
  } catch { return false; }
}

function startTikFinity() {
  if (isTikFinityRunning()) { log('[采集] TikFinity 已在运行'); return; }
  const exe = findTikFinityExe();
  if (!exe) {
    log('[采集] 未检测到 TikFinity（直播事件采集不可用）。安装一次即可：https://tikfinity.zerody.one/');
    log('[采集] 安装后点左侧 Connect TikTok Account 登录一次、Setup 里填主播名，之后全自动。');
    return;
  }
  const existingNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const noProxy = [...new Set([
    ...existingNoProxy.split(',').map((value) => value.trim()).filter(Boolean),
    'tikfinity.zerody.one',
    'tikfinity-origin.zerody.one',
  ])].join(',');
  const child = spawn(exe, [], {
    cwd: join(exe, '..'),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: { ...process.env, NO_PROXY: noProxy, no_proxy: noProxy },
  });
  child.unref(); // TikFinity 独立生存，中控退出不杀它（账号会话保持）
  log(`[采集] 已自动启动 TikFinity：${exe}`);
}

async function boot() {
  log(`GPU runtime profile=${GPU_RUNTIME.id}; GPU=${GPU_RUNTIME.gpuName || 'CPU'}; VRAM=${GPU_RUNTIME.vramMb || 0}MB`);
  log(`启动全家：根=${BUNDLE_ROOT} 中控=${APP_ROOT}`);
  startTikFinity();
  if (!await localServiceReady(PORT_TTS, '/health')) startGptSoVits();
  if (!await localServiceReady(PORT_MUSETALK, '/health')) startMuseTalk();
  if (!await localServiceReady(PORT_ACCENT, '/health')) startVoiceAccent();
  let ready = await healthCheck();
  if (!ready) {
    startOrchestrator();
    log('等待 中控 就绪…');
    ready = await waitHealth();
  } else {
    log('中控已在运行，直接打开');
  }
  createWindow();
  if (!ready) log('警告：中控未在预期时间内就绪，请查看日志');
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
    title: '梅花中控',
    icon: join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT_ADMIN}/`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildTray() {
  const iconPath = join(__dirname, 'build', 'icon.png');
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 }) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('梅花直播中控 · 全家桶');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开中控', click: () => createWindow() },
    { label: '重启全家服务', click: () => { stopChildren(); setTimeout(boot, 500); } },
    { type: 'separator' },
    { label: '退出', click: () => { stopChildren(); app.quit(); } },
  ]));
  tray.on('double-click', () => createWindow());
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else app.on('second-instance', () => createWindow());

app.whenReady().then(async () => {
  buildTray();
  await boot();
});

app.on('window-all-closed', (event) => {
  // 托盘常驻：窗口关闭不退出（保留托盘控制）
  event.preventDefault();
});

app.on('before-quit', () => {
  stopChildren();
});
