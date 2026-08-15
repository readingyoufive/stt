/*
 * Parakeet-TDT 0.6B v2 INT8 + contextual biasing.
 * v10.7 diagnostics: no Emscripten .data package. ONNX + tokenizer/support
 * files are fetched as browser Blobs with visible progress, mounted read-only
 * through WORKERFS, and sherpa/ORT stdout+stderr are forwarded to the page.
 */

const BUILD_REVISION = 'v10.7-workerfs-diagnostics';
const APP_BASE = new URL('./', self.location.href);
const RUNTIME_BASE = new URL('parakeet-sherpa/', APP_BASE);
const MODEL_BASE = new URL('parakeet-model/', APP_BASE);

const MODEL_FILES = [
  { name: 'tokens.txt', label: 'tokens', base: RUNTIME_BASE },
  { name: 'bpe.vocab', label: 'BPE vocab', base: RUNTIME_BASE },
  { name: 'encoder.int8.onnx', label: 'encoder INT8', base: MODEL_BASE },
  { name: 'decoder.int8.onnx', label: 'decoder INT8', base: MODEL_BASE },
  { name: 'joiner.int8.onnx', label: 'joiner INT8', base: MODEL_BASE },
];

let runtimeReady = false;
let runtimeFailed = null;
let modelMounted = false;
let modelMountPromise = null;
let modelBlobs = [];
let modelMountMetrics = null;
let recognizer = null;
let recognizerFingerprint = '';
let activePhase = { id: 'boot', label: 'démarrage Worker', startedAt: performance.now() };
let messageSeq = 0;

const nativeConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function nowIso() {
  return new Date().toISOString();
}

function emit(type, payload = {}) {
  self.postMessage({ type, seq: ++messageSeq, revision: BUILD_REVISION, workerNow: performance.now(), ...payload });
}

function postStatus(text, status = 'busy', extra = {}) {
  emit('status', { text, status, phase: activePhase.id, ...extra });
}

function logLine(source, text, level = 'info') {
  const line = String(text ?? '');
  emit('log', { source, level, text: line, phase: activePhase.id, at: nowIso() });
  if (level === 'error') nativeConsole.error(`[${source}] ${line}`);
  else if (level === 'warn') nativeConsole.warn(`[${source}] ${line}`);
  else nativeConsole.log(`[${source}] ${line}`);
}

function startPhase(id, label, detail = '') {
  activePhase = { id, label, detail, startedAt: performance.now() };
  emit('phase', { id, label, detail, startedAt: activePhase.startedAt });
  postStatus(detail ? `${label} · ${detail}` : label, 'busy');
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function runtimeUrl(name) {
  const u = new URL(name, RUNTIME_BASE);
  u.searchParams.set('build', BUILD_REVISION);
  return u.href;
}

function resolveFs() {
  const fs = Module?.FS || self.FS || (typeof FS !== 'undefined' ? FS : null);
  if (!fs?.mount || !fs?.writeFile || !fs?.stat) {
    throw new Error('Emscripten FS n’est pas exposé par le runtime sherpa-onnx.');
  }
  return fs;
}

function resolveWorkerFs() {
  const fs = resolveFs();
  const workerFs =
    fs?.filesystems?.WORKERFS ||
    Module?.FS?.filesystems?.WORKERFS ||
    self.FS?.filesystems?.WORKERFS ||
    Module?.WORKERFS ||
    self.WORKERFS ||
    (typeof WORKERFS !== 'undefined' ? WORKERFS : null);

  if (!workerFs) {
    const backends = Object.keys(fs?.filesystems || {}).join(', ') || '(aucun)';
    throw new Error(
      `WORKERFS indisponible. Backends FS détectés: ${backends}. ` +
      'Le runtime doit être lié avec -lworkerfs.js et la page doit utiliser le runtime v10.7.'
    );
  }
  return workerFs;
}

// Emscripten reads Module before the generated runtime script is evaluated.
var Module = {
  locateFile(path) {
    return runtimeUrl(path.split('/').pop());
  },
  setStatus(text) {
    if (text) postStatus(text, 'busy', { subphase: 'emscripten-status' });
  },
  monitorRunDependencies(left) {
    emit('runtime-dependencies', { left });
    if (left > 0) postStatus(`runtime WASM · ${left} dépendance${left > 1 ? 's' : ''} restante${left > 1 ? 's' : ''}…`);
  },
  print(text) {
    logLine('sherpa/stdout', text, 'info');
  },
  printErr(text) {
    logLine('sherpa/stderr', text, 'warn');
  },
  onRuntimeInitialized() {
    runtimeReady = true;
    const fs = (() => { try { return resolveFs(); } catch { return null; } })();
    emit('runtime-ready', {
      wasmMemoryBytes: Module?.HEAPU8?.byteLength || 0,
      fsBackends: Object.keys(fs?.filesystems || {}),
    });
  },
  onAbort(reason) {
    runtimeFailed = new Error(`sherpa-onnx a interrompu le runtime : ${reason || 'abort'}`);
    emit('error', { message: runtimeFailed.stack || runtimeFailed.message, phase: activePhase });
  },
};

emit('hello', {
  userAgent: self.navigator?.userAgent || '',
  hardwareConcurrency: self.navigator?.hardwareConcurrency || null,
  crossOriginIsolated: self.crossOriginIsolated === true,
  modelFiles: MODEL_FILES.map((f) => f.name),
});

// Heartbeat deliberately uses the Worker event loop. If a synchronous C++/WASM
// call blocks it, the page can see that the heartbeat has gone stale.
setInterval(() => {
  emit('heartbeat', {
    phase: activePhase.id,
    phaseLabel: activePhase.label,
    phaseElapsedMs: performance.now() - activePhase.startedAt,
    wasmMemoryBytes: Module?.HEAPU8?.byteLength || 0,
  });
}, 1000);

try {
  startPhase('runtime-script', 'chargement du runtime sherpa-onnx', BUILD_REVISION);
  importScripts(runtimeUrl('sherpa-onnx-asr.js'));
  importScripts(runtimeUrl('sherpa-onnx-wasm-main-vad-asr.js'));
} catch (error) {
  runtimeFailed = error;
  emit('error', { message: `Runtime Parakeet introuvable ou invalide : ${error?.stack || error?.message || error}`, phase: activePhase });
}

function waitForRuntime(timeoutMs = 120000) {
  if (runtimeFailed) return Promise.reject(runtimeFailed);
  if (runtimeReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(() => {
      if (runtimeFailed) {
        clearInterval(timer);
        reject(runtimeFailed);
      } else if (runtimeReady) {
        clearInterval(timer);
        resolve();
      } else if (performance.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timeout runtime après ${(timeoutMs / 1000).toFixed(0)} s. Aucun .data ne devrait être téléchargé en v10.7.`));
      }
    }, 100);
  });
}

function resourceTimingHint(url) {
  try {
    const entries = performance.getEntriesByName(url);
    const e = entries[entries.length - 1];
    if (!e) return null;
    let sourceHint = 'inconnu';
    if (e.transferSize === 0 && e.encodedBodySize > 0) sourceHint = 'cache probable';
    else if (e.transferSize > 0) sourceHint = 'réseau probable';
    return {
      sourceHint,
      transferSize: Number(e.transferSize || 0),
      encodedBodySize: Number(e.encodedBodySize || 0),
      decodedBodySize: Number(e.decodedBodySize || 0),
      durationMs: Number(e.duration || 0),
    };
  } catch {
    return null;
  }
}

function fetchModelBlob(file) {
  const url = new URL(file.name, file.base || MODEL_BASE).href;
  const t0 = performance.now();
  startPhase(`download:${file.name}`, `téléchargement ${file.label}`, file.name);

  // XMLHttpRequest with responseType=blob keeps the payload as a browser Blob
  // while exposing native progress events. This avoids accumulating ~600 MB of
  // Uint8Array chunks in JavaScript just to render a progress bar.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastReportAt = 0;
    let lastLoaded = 0;
    let lastAt = t0;

    xhr.open('GET', url, true);
    xhr.responseType = 'blob';
    xhr.timeout = 0;

    xhr.onprogress = (e) => {
      const now = performance.now();
      if (now - lastReportAt < 200 && !(e.lengthComputable && e.loaded === e.total)) return;
      const dt = Math.max(1, now - lastAt);
      const speedBps = Math.max(0, (e.loaded - lastLoaded) * 1000 / dt);
      lastLoaded = e.loaded;
      lastAt = now;
      lastReportAt = now;
      emit('file-progress', {
        file: file.name,
        label: file.label,
        loaded: Number(e.loaded || 0),
        total: e.lengthComputable ? Number(e.total || 0) : 0,
        lengthComputable: !!e.lengthComputable,
        speedBps,
        elapsedMs: now - t0,
      });
    };

    xhr.onload = () => {
      try {
        if (xhr.status < 200 || xhr.status >= 300) {
          throw new Error(`${file.name}: HTTP ${xhr.status} ${xhr.statusText}`);
        }
        const blob = xhr.response;
        if (!(blob instanceof Blob) || !blob.size) throw new Error(`${file.name}: réponse Blob vide ou invalide`);
        const elapsedMs = performance.now() - t0;
        const timing = resourceTimingHint(url);
        emit('file-complete', {
          file: file.name,
          label: file.label,
          bytes: blob.size,
          elapsedMs,
          timing,
        });
        logLine('download', `${file.name} · ${formatMb(blob.size)} · ${(elapsedMs / 1000).toFixed(1)} s · ${timing?.sourceHint || 'source inconnue'}`);
        resolve({ name: file.name, data: blob, bytes: blob.size, elapsedMs, timing });
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () => reject(new Error(`${file.name}: erreur réseau pendant le téléchargement`));
    xhr.onabort = () => reject(new Error(`${file.name}: téléchargement annulé`));
    xhr.send();
  });
}

async function mountExternalModel() {
  if (modelMounted) return modelMountMetrics;
  if (modelMountPromise) return modelMountPromise;

  modelMountPromise = (async () => {
    const started = performance.now();
    const fs = resolveFs();
    const workerFs = resolveWorkerFs();
    const blobs = [];

    // Sequential downloads make the diagnostic unambiguous and avoid several
    // simultaneous large HTTP responses on memory-constrained mobile browsers.
    for (const file of MODEL_FILES) {
      blobs.push(await fetchModelBlob(file));
    }

    startPhase('workefs-mount', 'montage WORKERFS', `${blobs.length} fichiers`);
    const mountStart = performance.now();
    try { fs.unmount('/models'); } catch {}
    try { fs.mkdir('/models'); } catch {}
    fs.mount(workerFs, { blobs: blobs.map(({ name, data }) => ({ name, data })) }, '/models');

    for (const item of blobs) {
      const path = `/models/${item.name}`;
      const stat = fs.stat(path);
      if (Number(stat.size) !== Number(item.bytes)) {
        throw new Error(`${item.name}: taille WORKERFS inattendue (${stat.size} != ${item.bytes})`);
      }
      emit('mount-check', { file: item.name, path, bytes: Number(stat.size) });
    }

    modelBlobs = blobs;
    modelMounted = true;
    modelMountMetrics = {
      elapsedMs: performance.now() - started,
      mountOnlyMs: performance.now() - mountStart,
      bytes: blobs.reduce((sum, item) => sum + item.bytes, 0),
      files: blobs.map(({ name, bytes, elapsedMs, timing }) => ({ name, bytes, elapsedMs, timing })),
    };

    emit('model-mounted', modelMountMetrics);
    logLine('WORKERFS', `montage validé · ${formatMb(modelMountMetrics.bytes)} · ${modelMountMetrics.mountOnlyMs.toFixed(0)} ms`);
    return modelMountMetrics;
  })();

  try {
    return await modelMountPromise;
  } finally {
    modelMountPromise = null;
  }
}

function normalizeHotwords(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join('\n');
}

function ensureRecognizer(hotwordsText, score) {
  if (!runtimeReady) throw new Error('Runtime sherpa-onnx pas encore prêt.');
  if (!modelMounted) throw new Error('Les poids Parakeet ne sont pas encore montés dans WORKERFS.');

  const normalized = normalizeHotwords(hotwordsText);
  const hotwordScore = Number(score) || 1.5;
  const useHotwords = normalized.length > 0;
  const fingerprint = `${useHotwords ? 'beam' : 'greedy'}|${hotwordScore}|${normalized}`;
  if (recognizer && fingerprint === recognizerFingerprint) return { reused: true, elapsedMs: 0 };

  try { recognizer?.free?.(); } catch {}
  recognizer = null;

  const fs = resolveFs();
  if (useHotwords) fs.writeFile('/hotwords.txt', `${normalized}\n`);

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: '/models/encoder.int8.onnx',
        decoder: '/models/decoder.int8.onnx',
        joiner: '/models/joiner.int8.onnx',
      },
      tokens: '/models/tokens.txt',
      numThreads: 1,
      debug: 1,
      provider: 'cpu',
      modelType: 'nemo_transducer',
      modelingUnit: useHotwords ? 'bpe' : 'cjkchar',
      bpeVocab: useHotwords ? '/models/bpe.vocab' : '',
    },
    decodingMethod: useHotwords ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths: 4,
    hotwordsFile: useHotwords ? '/hotwords.txt' : '',
    hotwordsScore: hotwordScore,
    blankPenalty: 0,
    debug: 1,
  };

  const label = useHotwords ? 'création recognizer · modified_beam_search + hotwords' : 'création recognizer · greedy_search';
  startPhase('recognizer-create', label, 'appel C++/ONNX Runtime synchrone');
  logLine('diagnostic', 'entrée dans new OfflineRecognizer(); si le heartbeat s’arrête ici, le Worker est occupé dans sherpa/ONNX Runtime.');
  emit('recognizer-config', {
    decodingMethod: config.decodingMethod,
    maxActivePaths: config.maxActivePaths,
    hotwordScore,
    hotwordCount: normalized ? normalized.split('\n').length : 0,
    encoder: config.modelConfig.transducer.encoder,
    wasmMemoryBytesBefore: Module?.HEAPU8?.byteLength || 0,
  });

  const t0 = performance.now();
  recognizer = new OfflineRecognizer(config, Module);
  const elapsedMs = performance.now() - t0;
  if (!recognizer?.handle) throw new Error('Impossible de créer OfflineRecognizer pour Parakeet.');
  recognizerFingerprint = fingerprint;

  emit('recognizer-created', {
    elapsedMs,
    wasmMemoryBytesAfter: Module?.HEAPU8?.byteLength || 0,
  });
  logLine('diagnostic', `OfflineRecognizer créé en ${(elapsedMs / 1000).toFixed(1)} s`);
  return { reused: false, elapsedMs };
}

async function initPipeline(msg) {
  const totalStart = performance.now();
  startPhase('runtime-wait', 'attente runtime WASM');
  const runtimeWaitStart = performance.now();
  await waitForRuntime();
  const runtimeWaitMs = performance.now() - runtimeWaitStart;

  const mountMetrics = await mountExternalModel();
  const recognizerMetrics = ensureRecognizer(msg.hotwords, msg.hotwordScore);

  startPhase('ready', 'Parakeet prêt');
  emit('ready', {
    mode: normalizeHotwords(msg.hotwords) ? 'modified_beam_search' : 'greedy_search',
    timings: {
      runtimeWaitMs,
      modelMountMs: mountMetrics?.elapsedMs || 0,
      workerFsMountOnlyMs: mountMetrics?.mountOnlyMs || 0,
      recognizerMs: recognizerMetrics.elapsedMs,
      recognizerReused: recognizerMetrics.reused,
      totalMs: performance.now() - totalStart,
      modelBytes: mountMetrics?.bytes || 0,
    },
  });
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      await initPipeline(msg);
      return;
    }

    if (msg.type === 'transcribe') {
      if (!runtimeReady || !modelMounted || !recognizer) await initPipeline(msg);
      else ensureRecognizer(msg.hotwords, msg.hotwordScore);

      const audio = new Float32Array(msg.audio);
      const stream = recognizer.createStream();
      try {
        stream.acceptWaveform(16000, audio);
        startPhase('decode', 'inférence Parakeet', `${(audio.length / 16000).toFixed(2)} s audio`);
        const t0 = performance.now();
        recognizer.decode(stream);
        const elapsedMs = performance.now() - t0;
        const result = recognizer.getResult(stream);
        startPhase('ready', 'Parakeet prêt');
        emit('result', {
          text: String(result?.text || '').trim(),
          elapsedMs,
          mode: normalizeHotwords(msg.hotwords) ? 'modified_beam_search' : 'greedy_search',
        });
      } finally {
        stream.free();
      }
    }
  } catch (error) {
    emit('error', {
      message: error?.stack || error?.message || String(error),
      phase: { ...activePhase, elapsedMs: performance.now() - activePhase.startedAt },
      wasmMemoryBytes: Module?.HEAPU8?.byteLength || 0,
    });
  }
};
