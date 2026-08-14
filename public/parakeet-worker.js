/*
 * Parakeet-TDT 0.6B v2 INT8 + contextual biasing.
 * Classic Worker because the official sherpa-onnx Emscripten bundle exposes globals.
 */

const APP_BASE = new URL('./', self.location.href);
const RUNTIME_BASE = new URL('parakeet-sherpa/', APP_BASE);
let runtimeReady = false;
let runtimeFailed = null;
let recognizer = null;
let recognizerFingerprint = '';

function postStatus(text, status = 'busy') {
  self.postMessage({ type: 'status', text, status });
}

// Emscripten reads Module before the generated runtime script is evaluated.
var Module = {
  locateFile(path) {
    return new URL(path.split('/').pop(), RUNTIME_BASE).href;
  },
  setStatus(text) {
    if (text) postStatus(text, 'busy');
  },
  monitorRunDependencies(left) {
    if (left > 0) postStatus(`préparation du runtime (${left} dépendance${left > 1 ? 's' : ''})…`, 'busy');
  },
  onRuntimeInitialized() {
    runtimeReady = true;
    self.postMessage({ type: 'runtime-ready' });
  },
  onAbort(reason) {
    runtimeFailed = new Error(`sherpa-onnx a interrompu le runtime : ${reason || 'abort'}`);
    self.postMessage({ type: 'error', message: runtimeFailed.message });
  },
};

try {
  postStatus('chargement sherpa-onnx 1.13.5 + Parakeet INT8 (~660 MB)…', 'busy');
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
    }, 150);
  });
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

  const normalized = normalizeHotwords(hotwordsText);
  const hotwordScore = Number(score) || 1.5;
  const useHotwords = normalized.length > 0;
  const fingerprint = `${useHotwords ? 'beam' : 'greedy'}|${hotwordScore}|${normalized}`;
  if (recognizer && fingerprint === recognizerFingerprint) return;

  try { recognizer?.free?.(); } catch {}
  recognizer = null;

  if (useHotwords) {
    // Emscripten's FS is a global in the classic WASM bundle. It is not
    // guaranteed to be attached as Module.FS unless explicitly exported.
    const emscriptenFS =
      Module?.FS ||
      self.FS ||
      (typeof FS !== 'undefined' ? FS : null);

    if (!emscriptenFS?.writeFile) {
      throw new Error(
        'Le runtime sherpa-onnx est chargé mais Emscripten FS.writeFile n\'est pas exposé. ' +
        'Vérifie que le bundle WASM v1.13.5 a été construit avec le wrapper officiel.'
      );
    }
    emscriptenFS.writeFile('/hotwords.txt', `${normalized}\n`);
  }

  const config = {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: './encoder.int8.onnx',
        decoder: './decoder.int8.onnx',
        joiner: './joiner.int8.onnx',
      },
      tokens: './tokens.txt',
      numThreads: 1,
      debug: 0,
      provider: 'cpu',
      modelType: 'nemo_transducer',
      modelingUnit: useHotwords ? 'bpe' : 'cjkchar',
      bpeVocab: useHotwords ? './bpe.vocab' : '',
    },
    decodingMethod: useHotwords ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths: 4,
    hotwordsFile: useHotwords ? './hotwords.txt' : '',
    hotwordsScore: hotwordScore,
    blankPenalty: 0,
    debug: 0,
  };

  postStatus(useHotwords ? 'création modified_beam_search + hotwords…' : 'création greedy_search…', 'busy');
  recognizer = new OfflineRecognizer(config, Module);
  if (!recognizer?.handle) throw new Error('Impossible de créer OfflineRecognizer pour Parakeet.');
  recognizerFingerprint = fingerprint;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === 'init') {
      await waitForRuntime();
      ensureRecognizer(msg.hotwords, msg.hotwordScore);
      self.postMessage({
        type: 'ready',
        mode: normalizeHotwords(msg.hotwords) ? 'modified_beam_search' : 'greedy_search',
      });
      return;
    }

    if (msg.type === 'transcribe') {
      await waitForRuntime();
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
