/*
 * Parakeet-TDT 0.6B v2 INT8 + contextual biasing.
 * v10.6: no Emscripten .data package. ONNX + tokenizer/support files
 * are fetched as browser Blobs and mounted read-only through WORKERFS.
 */

const APP_BASE = new URL('./', self.location.href);
const RUNTIME_BASE = new URL('parakeet-sherpa/', APP_BASE);
const MODEL_BASE = new URL('parakeet-model/', APP_BASE);

const MODEL_FILES = [
  { name: 'encoder.int8.onnx', label: 'encoder INT8', base: MODEL_BASE },
  { name: 'decoder.int8.onnx', label: 'decoder INT8', base: MODEL_BASE },
  { name: 'joiner.int8.onnx', label: 'joiner INT8', base: MODEL_BASE },
  { name: 'tokens.txt', label: 'tokens', base: RUNTIME_BASE },
  { name: 'bpe.vocab', label: 'BPE vocab', base: RUNTIME_BASE },
  { name: 'silero_vad.onnx', label: 'Silero VAD', base: RUNTIME_BASE },
];

let runtimeReady = false;
let runtimeFailed = null;
let runtimeReadyAt = 0;
let modelMounted = false;
let modelMountPromise = null;
let modelBlobs = [];
let modelMountMetrics = null;
let recognizer = null;
let recognizerFingerprint = '';

function postStatus(text, status = 'busy', extra = {}) {
  self.postMessage({ type: 'status', text, status, ...extra });
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function resolveFs() {
  const fs = Module?.FS || self.FS || (typeof FS !== 'undefined' ? FS : null);
  if (!fs?.mount || !fs?.writeFile) {
    throw new Error('Emscripten FS n’est pas exposé par le runtime sherpa-onnx.');
  }
  return fs;
}

function resolveWorkerFs() {
  const fs = resolveFs();

  // With Emscripten's legacy FS, linked filesystem backends are registered
  // on FS.filesystems. This is the most reliable access path for WORKERFS.
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
      'WORKERFS n’est pas disponible dans ce runtime. Backends FS détectés: ' + backends + '. ' +
      'Le runtime doit être lié avec -lworkerfs.js. Recharge la page après le nouveau déploiement v10.6.'
    );
  }

  return workerFs;
}

// Emscripten reads Module before the generated runtime script is evaluated.
var Module = {
  locateFile(path) {
    return new URL(path.split('/').pop(), RUNTIME_BASE).href;
  },
  setStatus(text) {
    if (text) postStatus(text, 'busy', { phase: 'runtime' });
  },
  monitorRunDependencies(left) {
    if (left > 0) {
      postStatus(`préparation du petit runtime (${left} dépendance${left > 1 ? 's' : ''})…`, 'busy', { phase: 'runtime' });
    }
  },
  onRuntimeInitialized() {
    runtimeReady = true;
    runtimeReadyAt = performance.now();
    self.postMessage({ type: 'runtime-ready' });
  },
  onAbort(reason) {
    runtimeFailed = new Error(`sherpa-onnx a interrompu le runtime : ${reason || 'abort'}`);
    self.postMessage({ type: 'error', message: runtimeFailed.message });
  },
};

try {
  postStatus('chargement du runtime sherpa-onnx (modèle externe)…', 'busy', { phase: 'runtime' });
  importScripts(new URL('parakeet-sherpa/sherpa-onnx-asr.js', APP_BASE).href);
  importScripts(new URL('parakeet-sherpa/sherpa-onnx-wasm-main-vad-asr.js', APP_BASE).href);
} catch (error) {
  runtimeFailed = error;
  self.postMessage({ type: 'error', message: `Runtime Parakeet introuvable ou invalide : ${error?.message || error}` });
}

function waitForRuntime(timeoutMs = 300000) {
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
        reject(new Error('Timeout pendant le chargement du runtime Parakeet.'));
      }
    }, 100);
  });
}

async function fetchModelBlob(file) {
  const url = new URL(file.name, file.base || MODEL_BASE).href;
  const t0 = performance.now();
  postStatus(`ouverture ${file.label}…`, 'busy', { phase: 'model', file: file.name });

  // force-cache asks the browser to reuse its HTTP cache when possible.
  // response.blob() gives WORKERFS a Blob without copying it into the WASM heap/MEMFS.
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`${file.name}: HTTP ${response.status} ${response.statusText}`);
  }

  const blob = await response.blob();
  if (!blob.size) throw new Error(`${file.name}: fichier vide`);
  const elapsedMs = performance.now() - t0;
  postStatus(`${file.label} disponible · ${formatMb(blob.size)}`, 'busy', {
    phase: 'model',
    file: file.name,
    bytes: blob.size,
    elapsedMs,
  });
  return { name: file.name, data: blob, bytes: blob.size, elapsedMs };
}

async function mountExternalModel() {
  if (modelMounted) return modelMountMetrics;
  if (modelMountPromise) return modelMountPromise;

  modelMountPromise = (async () => {
    const started = performance.now();
    const fs = resolveFs();
    const workerFs = resolveWorkerFs();

    // Load the large encoder first; all remaining files can be fetched together.
    const encoder = await fetchModelBlob(MODEL_FILES[0]);
    const rest = await Promise.all(MODEL_FILES.slice(1).map(fetchModelBlob));
    const blobs = [encoder, ...rest];

    postStatus('montage WORKERFS des poids ONNX…', 'busy', { phase: 'mount' });
    try { fs.mkdir('/models'); } catch {}
    try { fs.unmount('/models'); } catch {}
    fs.mount(workerFs, {
      blobs: blobs.map(({ name, data }) => ({ name, data })),
    }, '/models');

    for (const item of blobs) {
      const path = `/models/${item.name}`;
      const stat = fs.stat(path);
      if (Number(stat.size) !== Number(item.bytes)) {
        throw new Error(`${item.name}: taille WORKERFS inattendue (${stat.size} != ${item.bytes})`);
      }
    }

    // Keep references for the lifetime of the worker. WORKERFS reads synchronously from these Blobs.
    modelBlobs = blobs;
    modelMounted = true;
    modelMountMetrics = {
      elapsedMs: performance.now() - started,
      bytes: blobs.reduce((sum, item) => sum + item.bytes, 0),
      files: blobs.map(({ name, bytes, elapsedMs }) => ({ name, bytes, elapsedMs })),
    };

    self.postMessage({ type: 'model-mounted', ...modelMountMetrics });
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
  if (useHotwords) {
    fs.writeFile('/hotwords.txt', `${normalized}\n`);
  }

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: '/models/encoder.int8.onnx',
        decoder: '/models/decoder.int8.onnx',
        joiner: '/models/joiner.int8.onnx',
      },
      // Tokenizer/support files are mounted through WORKERFS too.
      tokens: '/models/tokens.txt',
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
      modelType: 'nemo_transducer',
      modelingUnit: useHotwords ? 'bpe' : 'cjkchar',
      bpeVocab: useHotwords ? '/models/bpe.vocab' : '',
    },
    decodingMethod: useHotwords ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths: 4,
    hotwordsFile: useHotwords ? './hotwords.txt' : '',
    hotwordsScore: hotwordScore,
    blankPenalty: 0,
    debug: 0,
  };

  postStatus(useHotwords ? 'création recognizer · modified_beam_search + hotwords…' : 'création recognizer · greedy_search…', 'busy', { phase: 'recognizer' });
  const t0 = performance.now();
  recognizer = new OfflineRecognizer(config, Module);
  const elapsedMs = performance.now() - t0;
  if (!recognizer?.handle) throw new Error('Impossible de créer OfflineRecognizer pour Parakeet.');
  recognizerFingerprint = fingerprint;
  return { reused: false, elapsedMs };
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      const totalStart = performance.now();
      const runtimeWaitStart = performance.now();
      await waitForRuntime();
      const runtimeWaitMs = performance.now() - runtimeWaitStart;
      const mountMetrics = await mountExternalModel();
      const recognizerMetrics = ensureRecognizer(msg.hotwords, msg.hotwordScore);
      self.postMessage({
        type: 'ready',
        mode: normalizeHotwords(msg.hotwords) ? 'modified_beam_search' : 'greedy_search',
        timings: {
          runtimeWaitMs,
          modelMountMs: mountMetrics?.elapsedMs || 0,
          recognizerMs: recognizerMetrics.elapsedMs,
          recognizerReused: recognizerMetrics.reused,
          totalMs: performance.now() - totalStart,
          modelBytes: mountMetrics?.bytes || 0,
        },
      });
      return;
    }

    if (msg.type === 'transcribe') {
      await waitForRuntime();
      await mountExternalModel();
      ensureRecognizer(msg.hotwords, msg.hotwordScore);
      const audio = new Float32Array(msg.audio);
      const stream = recognizer.createStream();
      try {
        stream.acceptWaveform(16000, audio);
        const t0 = performance.now();
        recognizer.decode(stream);
        const elapsedMs = performance.now() - t0;
        const result = recognizer.getResult(stream);
        self.postMessage({
          type: 'result',
          text: String(result?.text || '').trim(),
          elapsedMs,
          mode: normalizeHotwords(msg.hotwords) ? 'modified_beam_search' : 'greedy_search',
        });
      } finally {
        stream.free();
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.stack || error?.message || String(error) });
  }
};
