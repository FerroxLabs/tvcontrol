/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate, CDP_HOST, CDP_PORT } from '../connection.js';
import { existsSync, cpSync, rmSync, readdirSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { execFileSync, spawn } from 'child_process';
import { dirname, basename, join, win32 as pathWin32 } from 'path';
import { homedir } from 'os';
import { ClassifiedError, CATEGORIES } from '../errors.js';

export const RECONNECT_TEXT_PATTERN = /^(?:reconnecting|connecting|offline|no connection|connection lost|reconectando|conectando|sin conexi[oó]n|conexi[oó]n perdida|verbindung wird wiederhergestellt|verbinden|keine verbindung|verbindung verloren|reconnexion|connexion en cours|hors ligne|pas de connexion|connexion perdue|sem conex[aã]o|conex[aã]o perdida|กำลังเชื่อมต่อใหม่|กำลังเชื่อมต่อ|ออฟไลน์|ไม่มีการเชื่อมต่อ|再接続中|接続中|オフライン)\.{0,3}$/i;
export function _isReconnectText(value) {
  return RECONNECT_TEXT_PATTERN.test(String(value || '').trim());
}

const HEALTH_PROBE_JS = `
  (function() {
    function hasFunction(value, name) { return !!value && typeof value[name] === 'function'; }
    var reconnectText = new RegExp(${JSON.stringify(RECONNECT_TEXT_PATTERN.source)}, 'i');
    var result = { url: window.location.href, title: document.title, browserOnline: navigator.onLine !== false };
    var chart = null, widget = null, model = null, inner = null, series = null;
    try {
      chart = window.TradingViewApi._activeChartWidgetWV.value();
      widget = chart._chartWidget;
      model = widget.model();
      inner = model.model();
      series = model.mainSeries();
      result.symbol = chart.symbol();
      result.resolution = chart.resolution();
      result.chartType = chart.chartType();
      result.apiAvailable = true;
    } catch(e) {
      result.symbol = 'unknown';
      result.resolution = 'unknown';
      result.chartType = null;
      result.apiAvailable = false;
      result.apiError = e.message;
    }

    var checks = {
      active_chart: !!chart,
      chart_symbol: hasFunction(chart, 'symbol'),
      chart_resolution: hasFunction(chart, 'resolution'),
      chart_studies: hasFunction(chart, 'getAllStudies'),
      chart_widget_model: hasFunction(widget, 'model'),
      main_series: !!series,
      main_series_bars: hasFunction(series, 'bars'),
      model_data_sources: hasFunction(inner, 'dataSources')
    };
    var missing = [];
    Object.keys(checks).forEach(function(name) { if (!checks[name]) missing.push(name); });
    var ua = navigator.userAgent || '';
    var versionMatch = ua.match(/TVDesktop\\/([0-9.]+)/) || ua.match(/TradingView\\/([0-9.]+)/);
    result.compatibility = {
      compatible: missing.length === 0,
      checks: checks,
      missing: missing,
      desktop_version: versionMatch ? versionMatch[1] : null
    };

    var feedConnected = null;
    var disconnectCount = null;
    try {
      var feed = window.ChartApiInstance;
      if (feed && typeof feed.connected === 'function') feedConnected = !!feed.connected();
      else if (feed && typeof feed._isConnected === 'boolean') feedConnected = feed._isConnected;
      if (feed && typeof feed.disconnectCount === 'function') disconnectCount = feed.disconnectCount();
      else if (feed && typeof feed._disconnectCount === 'number') disconnectCount = feed._disconnectCount;
    } catch(e) {}

    var seriesStatus = null;
    var seriesStatusError = null;
    try {
      if (series && typeof series.status === 'function') seriesStatus = series.status();
      if (series && typeof series.isStatusError === 'function') seriesStatusError = !!series.isStatusError();
    } catch(e) {}

    var reconnectIndicator = false;
    try {
      var nodes = document.querySelectorAll('[role="alert"], [role="status"], [data-name], [class*="toast"], [class*="notification"]');
      for (var i = 0; i < nodes.length && i < 500; i++) {
        var node = nodes[i];
        if (!(node.offsetWidth || node.offsetHeight || node.getClientRects().length)) continue;
        var text = (node.textContent || '').trim();
        if (reconnectText.test(text)) {
          reconnectIndicator = true;
          break;
        }
      }
      if (!reconnectIndicator && document.body) {
        var lines = (document.body.innerText || '').slice(0, 200000).split('\\n');
        for (var j = 0; j < lines.length; j++) {
          if (reconnectText.test(lines[j].trim())) {
            reconnectIndicator = true;
            break;
          }
        }
      }
    } catch(e) {}

    var feedState = 'unknown';
    if (!result.browserOnline) feedState = 'offline';
    else if (reconnectIndicator) feedState = 'reconnecting';
    else if (feedConnected === false) feedState = 'disconnected';
    else if (feedConnected === true && seriesStatusError !== true) feedState = 'connected';
    else if (seriesStatusError === true) feedState = 'series_error';
    result.datafeed = {
      state: feedState,
      connected: feedConnected,
      browser_online: result.browserOnline,
      reconnect_indicator: reconnectIndicator,
      disconnect_count: disconnectCount,
      series_status: seriesStatus,
      series_status_error: seriesStatusError
    };
    return result;
  })()
`;

function _healthDeps(overrides) {
  return {
    getClient: overrides?.getClient || getClient,
    getTargetInfo: overrides?.getTargetInfo || getTargetInfo,
    evaluate: overrides?.evaluate || evaluate,
  };
}

export async function healthCheck({ _deps } = {}) {
  const deps = _healthDeps(_deps);
  await deps.getClient();
  const target = await deps.getTargetInfo();

  const state = await deps.evaluate(HEALTH_PROBE_JS);

  let targetUrl = '';
  try {
    const parsed = new URL(target.url);
    // Layout/chart IDs in /chart/<id>/ are stable account-linked identifiers;
    // health needs the route, not the identifier.
    const pathname = parsed.pathname.replace(/^\/chart\/[^/]+\/?/, '/chart/');
    targetUrl = `${parsed.origin}${pathname}`;
  } catch (_) { /* malformed target URL */ }
  const warnings = [];
  if (!state?.apiAvailable) warnings.push('TradingView chart API is unavailable.');
  if (state?.compatibility?.compatible === false) warnings.push(`Required TradingView APIs missing: ${state.compatibility.missing.join(', ')}`);
  if (state?.datafeed?.state && state.datafeed.state !== 'connected') warnings.push(`TradingView market data state is ${state.datafeed.state}.`);
  const healthy = !!state?.apiAvailable
    && state?.compatibility?.compatible === true
    && state?.datafeed?.state === 'connected';
  return {
    success: true,
    healthy,
    status: healthy ? 'healthy' : 'degraded',
    cdp_connected: true,
    target_url: targetUrl,
    target_title: target.title,
    chart_symbol: state?.symbol || 'unknown',
    chart_resolution: state?.resolution || 'unknown',
    chart_type: state?.chartType ?? null,
    api_available: state?.apiAvailable ?? false,
    datafeed: state?.datafeed || { state: 'unknown' },
    compatibility: state?.compatibility || { compatible: false, missing: ['health_probe_failed'] },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function compatibilityCheck({ _deps } = {}) {
  const deps = _healthDeps(_deps);
  await deps.getClient();
  const state = await deps.evaluate(HEALTH_PROBE_JS);
  return {
    success: true,
    ...(state?.compatibility || { compatible: false, checks: {}, missing: ['health_probe_failed'], desktop_version: null }),
    datafeed_probe_available: state?.datafeed?.connected !== null && state?.datafeed?.connected !== undefined,
  };
}

export async function discover({ _deps } = {}) {
  const deps = _healthDeps(_deps);
  const paths = await deps.evaluate(`
    (function() {
      var results = {};
      function methodsOf(value, limit) {
        var methods = [], seen = {}, current = value;
        for (var depth = 0; current && depth < 6; depth++, current = Object.getPrototypeOf(current)) {
          var names = [];
          try { names = Object.getOwnPropertyNames(current); } catch(e) {}
          for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (seen[name]) continue;
            seen[name] = true;
            try { if (typeof value[name] === 'function') methods.push(name); } catch(e) {}
          }
        }
        methods.sort();
        var hash = 2166136261;
        var signatureInput = methods.join('\\n');
        for (var h = 0; h < signatureInput.length; h++) {
          hash ^= signatureInput.charCodeAt(h);
          hash = Math.imul(hash, 16777619);
        }
        return { count: methods.length, methods: methods.slice(0, limit), signature: ('00000000' + (hash >>> 0).toString(16)).slice(-8) };
      }
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var chartMethods = methodsOf(chart, 50);
        results.chartApi = { available: true, path: 'window.TradingViewApi._activeChartWidgetWV.value()', methodCount: chartMethods.count, method_signature: chartMethods.signature, methods: chartMethods.methods };
      } catch(e) { results.chartApi = { available: false, error: e.message }; }
      try {
        var col = window.TradingViewApi._chartWidgetCollection;
        var colMethods = methodsOf(col, 30);
        results.chartWidgetCollection = { available: !!col, path: 'window.TradingViewApi._chartWidgetCollection', methodCount: colMethods.count, method_signature: colMethods.signature, methods: colMethods.methods };
      } catch(e) { results.chartWidgetCollection = { available: false, error: e.message }; }
      try {
        var ws = window.ChartApiInstance;
        var wsMethods = methodsOf(ws, 30);
        results.chartApiInstance = { available: !!ws, path: 'window.ChartApiInstance', methodCount: wsMethods.count, method_signature: wsMethods.signature, methods: wsMethods.methods };
      } catch(e) { results.chartApiInstance = { available: false, error: e.message }; }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var bwbMethods = methodsOf(bwb, 20);
        results.bottomWidgetBar = { available: !!bwb, path: 'window.TradingView.bottomWidgetBar', methodCount: bwbMethods.count, method_signature: bwbMethods.signature, methods: bwbMethods.methods };
      } catch(e) { results.bottomWidgetBar = { available: false, error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        results.replayApi = { available: !!replay, path: 'window.TradingViewApi._replayApi' };
      } catch(e) { results.replayApi = { available: false, error: e.message }; }
      try {
        var alerts = window.TradingViewApi._alertService;
        results.alertService = { available: !!alerts, path: 'window.TradingViewApi._alertService' };
      } catch(e) { results.alertService = { available: false, error: e.message }; }
      return results;
    })()
  `);

  const available = Object.values(paths).filter(v => v.available).length;
  const total = Object.keys(paths).length;

  return { success: true, apis_available: available, apis_total: total, apis: paths };
}

const COMPATIBILITY_DIR = join(homedir(), '.tv-mcp', 'compatibility');
const MAX_COMPATIBILITY_BASELINES = 20;

function _compatibilitySurface(discovery) {
  const result = {};
  for (const [name, api] of Object.entries(discovery?.apis || {})) {
    result[name] = {
      available: !!api?.available,
      method_count: api?.methodCount ?? null,
      method_signature: api?.method_signature ?? null,
    };
  }
  return result;
}

export async function compatibilitySnapshot({ action = 'compare', overwrite = false, _deps } = {}) {
  const dir = _deps?.dir || COMPATIBILITY_DIR;
  const read = _deps?.readFileSync || readFileSync;
  const write = _deps?.writeFileSync || writeFileSync;
  const rename = _deps?.renameSync || renameSync;
  const mkdir = _deps?.mkdirSync || mkdirSync;
  const listDir = _deps?.readdirSync || readdirSync;
  const stat = _deps?.statSync || statSync;
  const unlink = _deps?.unlinkSync || unlinkSync;
  const getCompatibility = _deps?.compatibilityCheck || (() => compatibilityCheck({ _deps }));
  const getDiscovery = _deps?.discover || (() => discover({ _deps }));

  if (action === 'list') {
    let files = [];
    try { files = listDir(dir).filter((name) => name.endsWith('.json')).sort(); } catch (_) {}
    return { success: true, count: files.length, versions: files.map((name) => name.slice(0, -5)) };
  }
  if (action !== 'compare' && action !== 'record') {
    throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'compatibility snapshot action must be compare, record, or list');
  }

  const [compatibility, discovery] = await Promise.all([getCompatibility(), getDiscovery()]);
  const version = String(compatibility.desktop_version || 'unknown').replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 80);
  const file = join(dir, `${version}.json`);
  const current = {
    schema_version: 1,
    recorded_at: new Date().toISOString(),
    desktop_version: compatibility.desktop_version || null,
    critical: {
      compatible: compatibility.compatible,
      checks: compatibility.checks || {},
      missing: compatibility.missing || [],
    },
    surfaces: _compatibilitySurface(discovery),
  };

  let baseline = null;
  try { baseline = JSON.parse(read(file, 'utf8')); } catch (_) {}
  const surface_drift = [];
  if (baseline) {
    for (const [name, surface] of Object.entries(current.surfaces)) {
      const prior = baseline.surfaces?.[name];
      if (!prior || prior.available !== surface.available || prior.method_count !== surface.method_count || prior.method_signature !== surface.method_signature) {
        surface_drift.push({ name, baseline: prior || null, current: surface });
      }
    }
  }

  if (action === 'record') {
    if (baseline && !overwrite) {
      return { success: true, recorded: false, reason: 'baseline_exists', file, desktop_version: compatibility.desktop_version, surface_drift };
    }
    mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    write(tmp, JSON.stringify(current, null, 2));
    rename(tmp, file);
    // Desktop versions are low-cardinality, but bound the directory anyway so
    // malformed/dev builds cannot grow local state forever.
    try {
      const files = listDir(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => ({ name, mtime: stat(join(dir, name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const old of files.slice(MAX_COMPATIBILITY_BASELINES)) unlink(join(dir, old.name));
    } catch (_) { /* pruning is best-effort; the recorded baseline remains valid */ }
    return { success: true, recorded: true, file, desktop_version: compatibility.desktop_version };
  }

  return {
    success: true,
    baseline_found: !!baseline,
    file,
    desktop_version: compatibility.desktop_version,
    critical_compatible: compatibility.compatible,
    critical_missing: compatibility.missing || [],
    surface_drift,
  };
}

export async function uiState() {
  const state = await evaluate(`
    (function() {
      var ui = {};
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      ui.bottom_panel = { open: !!(bottom && bottom.offsetHeight > 50), height: bottom ? bottom.offsetHeight : 0 };
      var right = document.querySelector('[class*="layout__area--right"]');
      ui.right_panel = { open: !!(right && right.offsetWidth > 50), width: right ? right.offsetWidth : 0 };
      var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
      ui.pine_editor = { open: !!monacoEl, width: monacoEl ? monacoEl.offsetWidth : 0, height: monacoEl ? monacoEl.offsetHeight : 0 };
      var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
      ui.strategy_tester = { open: !!(stratPanel && stratPanel.offsetParent) };
      var widgetbar = document.querySelector('[data-name="widgetbar-wrap"]');
      ui.widgetbar = { open: !!(widgetbar && widgetbar.offsetWidth > 50) };
      ui.buttons = {};
      var btns = document.querySelectorAll('button');
      var seen = {};
      var emitted = 0;
      for (var i = 0; i < btns.length; i++) {
        if (emitted >= 100) break;
        var b = btns[i];
        if (b.offsetParent === null || b.offsetWidth < 15) continue;
        var text = b.textContent.trim();
        var aria = b.getAttribute('aria-label') || '';
        var dn = b.getAttribute('data-name') || '';
        var label = text || aria || dn;
        if (!label || label.length > 60) continue;
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(label)) label = '[redacted email]';
        var key = label.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 40);
        if (seen[key]) continue;
        seen[key] = true;
        var rect = b.getBoundingClientRect();
        var region = 'other';
        if (rect.y < 50) region = 'top_bar';
        else if (rect.y < 90 && rect.x < 650) region = 'toolbar';
        else if (rect.x < 45) region = 'left_sidebar';
        else if (rect.x > 650 && rect.y < 100) region = 'pine_header';
        else if (rect.y > 750) region = 'bottom_bar';
        if (!ui.buttons[region]) ui.buttons[region] = [];
        ui.buttons[region].push({ label: label.substring(0, 40), disabled: b.disabled, x: Math.round(rect.x), y: Math.round(rect.y) });
        emitted++;
      }
      ui.button_count = emitted;
      ui.buttons_truncated = btns.length > emitted && emitted >= 100;
      ui.key_buttons = {};
      var keyLabels = {
        'add_to_chart': /add to chart/i, 'save_and_add': /save and add/i,
        'update_on_chart': /update on chart/i, 'save': /^Save(Save)?$/,
        'saved': /^Saved/, 'publish_script': /publish script/i,
        'compile_errors': /error/i, 'unsaved_version': /unsaved version/i,
      };
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var text = b.textContent.trim();
        for (var k in keyLabels) {
          if (keyLabels[k].test(text)) {
            ui.key_buttons[k] = { text: text.substring(0, 40), disabled: b.disabled, visible: b.offsetWidth > 0 };
          }
        }
      }
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        ui.chart = { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType(), study_count: chart.getAllStudies().length };
      } catch(e) { ui.chart = { error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
        ui.replay = { available: unwrap(replay.isReplayAvailable()), started: unwrap(replay.isReplayStarted()) };
      } catch(e) { ui.replay = { error: e.message }; }
      return ui;
    })()
  `);

  return { success: true, ...state };
}

const WINDOWS_APPS_RE = /\\WindowsApps\\/i;

async function _probeCdp(cdpPort) {
  const http = await import('http');
  return new Promise((resolve) => {
    const req = http.get(`http://${CDP_HOST}:${cdpPort}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

function _resolveLaunchDeps(deps) {
  return {
    platform: deps?.platform || process.platform,
    localAppData: deps?.localAppData ?? process.env.LOCALAPPDATA ?? '',
    home: deps?.home ?? process.env.HOME ?? '',
    programFiles: deps?.programFiles ?? process.env.PROGRAMFILES ?? '',
    programFilesX86: deps?.programFilesX86 ?? process.env['PROGRAMFILES(X86)'] ?? '',
    spawn: deps?.spawn || spawn,
    execFileSync: deps?.execFileSync || execFileSync,
    existsSync: deps?.existsSync || existsSync,
    cpSync: deps?.cpSync || cpSync,
    rmSync: deps?.rmSync || rmSync,
    readdirSync: deps?.readdirSync || readdirSync,
    mkdirSync: deps?.mkdirSync || mkdirSync,
    delay: deps?.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    probeCdp: deps?.probeCdp || _probeCdp,
    spawnFailedEarly: deps?.spawnFailedEarly || _spawnFailedEarly,
  };
}

function _spawnDetached(spawnFn, executable, args) {
  const child = spawnFn(executable, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

function _spawnFailedEarly(child, graceMs = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(null); }, graceMs);
    const onError = (error) => { cleanup(); resolve(error.code || error.message || 'spawn error'); };
    const onExit = (code) => { cleanup(); resolve(`exited immediately (code ${code})`); };
    const cleanup = () => {
      clearTimeout(timer);
      child.off?.('error', onError);
      child.off?.('exit', onExit);
    };
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function _waitForCdp({ cdpPort, attempts, delay, probeCdp }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await delay(1000);
    try {
      const value = await probeCdp(cdpPort);
      if (value) return typeof value === 'string' ? JSON.parse(value) : value;
    } catch (_) { /* retry */ }
  }
  return null;
}

function _copyMsixPackageLocal(tvPath, deps) {
  const pathApi = deps.platform === 'win32' ? pathWin32 : { dirname, basename, join };
  const sourceDir = pathApi.dirname(tvPath);
  const packageName = pathApi.basename(sourceDir);
  const cacheRoot = pathApi.join(deps.localAppData, 'tvcontrol', 'desktop-cache');
  const destinationDir = pathApi.join(cacheRoot, packageName);
  const destinationExe = pathApi.join(destinationDir, 'TradingView.exe');
  if (!deps.existsSync(destinationExe)) {
    deps.mkdirSync(cacheRoot, { recursive: true });
    try {
      for (const entry of deps.readdirSync(cacheRoot)) {
        if (entry !== packageName && /^TradingView\./i.test(entry)) {
          deps.rmSync(pathApi.join(cacheRoot, entry), { recursive: true, force: true });
        }
      }
    } catch (_) { /* empty cache */ }
    deps.cpSync(sourceDir, destinationDir, { recursive: true });
  }
  return destinationExe;
}

export async function launch({ port, kill_existing, _deps } = {}) {
  const deps = _resolveLaunchDeps(_deps);
  const cdpPort = port || CDP_PORT;
  // Killing a user's running Desktop session is destructive (unsaved Pine,
  // layouts, and dialogs can be lost). Require explicit opt-in instead of
  // making process termination the default side effect of a health command.
  const killFirst = kill_existing === true;
  const platform = deps.platform;

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${deps.home}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${deps.localAppData}\\TradingView\\TradingView.exe`,
      `${deps.programFiles}\\TradingView\\TradingView.exe`,
      `${deps.programFilesX86}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${deps.home}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && deps.existsSync(p)) { tvPath = p; break; }
  }

  if (!tvPath && platform === 'win32') {
    try {
      const installDir = deps.execFileSync('powershell', [
        '-NoProfile',
        '-Command',
        "(Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue).InstallLocation",
      ], { timeout: 5000 }).toString().trim();
      const candidate = installDir ? `${installDir}\\TradingView.exe` : '';
      if (candidate && deps.existsSync(candidate)) tvPath = candidate;
    } catch (_) { /* not an MSIX install */ }
  }

  if (!tvPath) {
    try {
      // execFileSync (not execSync) so no shell is involved — the program
      // and args are passed directly to the OS. Defense-in-depth: today
      // these args are literal strings, but switching to the no-shell form
      // makes future maintainers' interpolation mistakes a non-issue.
      const cmd = platform === 'win32' ? 'where' : 'which';
      const arg = platform === 'win32' ? 'TradingView.exe' : 'tradingview';
      tvPath = deps.execFileSync(cmd, [arg], { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !deps.existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      // mdfind with no shell pipe — take the first line in JS instead of
      // `| head -1`. Same outcome, no shell interpretation.
      const raw = deps.execFileSync('mdfind', ['kMDItemFSName == TradingView.app'], { timeout: 5000 }).toString();
      const found = raw.split('\n').map(s => s.trim()).find(Boolean);
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (deps.existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new ClassifiedError(
      CATEGORIES.TV_NOT_RUNNING,
      `TradingView not found on ${platform}. Searched: ${candidates.join(', ')}.`,
      { hint: `Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}` },
    );
  }

  const killExisting = async () => {
    try {
      if (platform === 'win32') {
        deps.execFileSync('taskkill', ['/F', '/IM', 'TradingView.exe'], { timeout: 5000 });
      } else {
        // -x: exact process-name match. -f matches the full command line, so
        // any process whose path or args contained "TradingView" — including
        // the MCP server itself when running from a directory named
        // .../TradingView/... — would be killed too. -x scopes to the
        // binary name only.
        deps.execFileSync('pkill', ['-x', 'TradingView'], { timeout: 5000 });
      }
      await deps.delay(1500);
    } catch { /* may not be running */ }
  };
  if (killFirst) await killExisting();

  const args = [`--remote-debugging-port=${cdpPort}`];
  let child = _spawnDetached(deps.spawn, tvPath, args);
  let info = null;
  let usedLocalCopy = false;

  if (platform === 'win32' && WINDOWS_APPS_RE.test(tvPath)) {
    const earlyFailure = await deps.spawnFailedEarly(child);
    if (!earlyFailure) {
      info = await _waitForCdp({ cdpPort, attempts: 15, delay: deps.delay, probeCdp: deps.probeCdp });
    }
    if (!info) {
      const localExecutable = _copyMsixPackageLocal(tvPath, deps);
      await killExisting();
      child = _spawnDetached(deps.spawn, localExecutable, args);
      tvPath = localExecutable;
      usedLocalCopy = true;
    }
  } else {
    const earlyFailure = await deps.spawnFailedEarly(child);
    if (earlyFailure) {
      throw new ClassifiedError(CATEGORIES.TV_NOT_RUNNING, `TradingView failed during startup: ${earlyFailure}`);
    }
  }

  if (!info) {
    info = await _waitForCdp({ cdpPort, attempts: 15, delay: deps.delay, probeCdp: deps.probeCdp });
  }
  if (info) {
    return {
      success: true, platform, binary: tvPath, pid: child.pid,
      cdp_port: cdpPort, cdp_url: `http://${CDP_HOST}:${cdpPort}`,
      browser: info.Browser, user_agent: info['User-Agent'],
      ...(usedLocalCopy ? { msix_local_copy: true } : {}),
    };
  }

  return {
    success: false, platform, binary: tvPath, pid: child.pid, cdp_port: cdpPort, cdp_ready: false,
    ...(usedLocalCopy ? { msix_local_copy: true } : {}),
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
