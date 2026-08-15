const $ = (id) => document.getElementById(id);
const setStatus = (id, text, cls = 'idle') => {
  const e = $(id);
  e.textContent = text;
  e.className = `status ${cls}`;
};

const recordBtn = $('recordBtn');
const stopBtn = $('stopBtn');
const runBtn = $('runBtn');
const playback = $('playback');
const timer = $('timer');
const level = $('level');
const hotwords = $('hotwords');
const scoreInput = $('parakeetHotwordScore');
const initParakeetBtn = $('initParakeetBtn');
const parakeetProgress = $('parakeetProgress');
const parakeetProgressText = $('parakeetProgressText');

let audioContext;
let mediaStream;
let sourceNode;
let workletNode;
let recordingStartedAt = 0;
let timerId;
let inputChunks = [];
let inputSampleRate = 48000;
let currentAudio = null;
let currentAudioUrl = null;

function concatFloat32(chunks) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function downsampleBuffer(buffer, inputRate, outputRate = 16000) {
  if (inputRate === outputRate) return new Float32Array(buffer);
  const ratio = inputRate / outputRate;
  const n = Math.floor(buffer.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(buffer.length, Math.floor((i + 1) * ratio));
    let s = 0;
    let c = 0;
    for (let j = a; j < b; j++) { s += buffer[j]; c++; }
    out[i] = c ? s / c : 0;
  }
  return out;
}

function wavBlob(samples, sr = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (const x of samples) {
    const s = Math.max(-1, Math.min(1, x));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([v], { type: 'audio/wav' });
}

async function startRecording() {
  if (!window.isSecureContext) throw new Error(`Le micro nécessite HTTPS ou http://localhost. URL actuelle : ${location.href}`);
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia indisponible dans ce navigateur/contexte.');

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioCtx();
  inputSampleRate = audioContext.sampleRate;
  await audioContext.audioWorklet.addModule(new URL('pcm-capture-worklet.js', document.baseURI).href);
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
  });

  inputChunks = [];
  workletNode.port.onmessage = (e) => {
    const raw = new Float32Array(e.data);
    inputChunks.push(raw);
    let rms = 0;
    for (let i = 0; i < raw.length; i++) rms += raw[i] * raw[i];
    rms = Math.sqrt(rms / raw.length);
    level.style.width = `${Math.min(100, rms * 420)}%`;
  };

  sourceNode.connect(workletNode);
  recordingStartedAt = performance.now();
  timerId = setInterval(() => { timer.textContent = `${((performance.now() - recordingStartedAt) / 1000).toFixed(1)} s`; }, 100);
  recordBtn.disabled = true;
  stopBtn.disabled = false;
  runBtn.disabled = true;
}

async function stopRecording() {
  clearInterval(timerId);
  try { sourceNode?.disconnect(); workletNode?.disconnect(); } catch {}
  mediaStream?.getTracks().forEach((t) => t.stop());
  await audioContext?.close();

  currentAudio = downsampleBuffer(concatFloat32(inputChunks), inputSampleRate, 16000);
  const d = currentAudio.length / 16000;
  timer.textContent = `${d.toFixed(1)} s`;
  level.style.width = '0%';

  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = URL.createObjectURL(wavBlob(currentAudio));
  playback.src = currentAudioUrl;

  recordBtn.disabled = false;
  stopBtn.disabled = true;
  runBtn.disabled = currentAudio.length < 1600;
  $('whisperAudio').textContent = `${d.toFixed(2)} s`;
  $('parakeetAudio').textContent = `${d.toFixed(2)} s`;
}

// Whisper --------------------------------------------------------------------
const whisperWorker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
let whisperResolve;
let whisperReject;

whisperWorker.onmessage = (e) => {
  const m = e.data || {};
  if (m.type === 'progress') setStatus('whisperStatus', `chargement ${Math.round(m.progress)}%`, 'busy');
  else if (m.type === 'status') setStatus('whisperStatus', m.text, m.status === 'ready' ? 'ready' : 'busy');
  else if (m.type === 'result') { whisperResolve?.(m); whisperResolve = whisperReject = null; }
  else if (m.type === 'error') {
    setStatus('whisperStatus', 'erreur', 'error');
    whisperReject?.(new Error(m.message));
    whisperResolve = whisperReject = null;
  }
};
whisperWorker.postMessage({ type: 'load' });

function runWhisper(audio) {
  return new Promise((resolve, reject) => {
    whisperResolve = resolve;
    whisperReject = reject;
    const c = audio.slice();
    whisperWorker.postMessage({ type: 'transcribe', audio: c.buffer }, [c.buffer]);
  });
}

// Parakeet -------------------------------------------------------------------
const PARAKEET_BUILD = 'v10.7-workerfs-diagnostics';
const parakeetPhase = $('parakeetPhase');
const parakeetPhaseDetail = $('parakeetPhaseDetail');
const parakeetPhaseElapsed = $('parakeetPhaseElapsed');
const parakeetHeartbeat = $('parakeetHeartbeat');
const parakeetFiles = $('parakeetFiles');
const parakeetDebugLog = $('parakeetDebugLog');
const clearParakeetLogBtn = $('clearParakeetLogBtn');
const copyParakeetLogBtn = $('copyParakeetLogBtn');
const resetParakeetWorkerBtn = $('resetParakeetWorkerBtn');

let parakeetWorker = null;
let parakeetReady = false;
let parakeetInitResolve = null;
let parakeetInitReject = null;
let parakeetRunResolve = null;
let parakeetRunReject = null;
let parakeetPhaseId = 'idle';
let parakeetPhaseStartedAt = performance.now();
let lastParakeetSignalAt = 0;
let parakeetRevision = null;
const parakeetLogLines = [];
const parakeetFileRows = new Map();

function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (!n) return '0 B';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fmtDuration(ms) {
  const s = Math.max(0, Number(ms || 0)) / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${(s - m * 60).toFixed(0)} s`;
}

function appendParakeetLog(text, level = 'info') {
  const stamp = new Date().toLocaleTimeString('fr-FR', { hour12: false });
  const prefix = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN ' : 'INFO ';
  parakeetLogLines.push(`${stamp} ${prefix} ${String(text)}`);
  if (parakeetLogLines.length > 500) parakeetLogLines.splice(0, parakeetLogLines.length - 500);
  parakeetDebugLog.textContent = parakeetLogLines.join('\n');
  parakeetDebugLog.scrollTop = parakeetDebugLog.scrollHeight;
}

clearParakeetLogBtn.addEventListener('click', () => {
  parakeetLogLines.length = 0;
  parakeetDebugLog.textContent = `${PARAKEET_BUILD} · journal effacé.`;
});

copyParakeetLogBtn.addEventListener('click', async () => {
  const text = parakeetLogLines.join('\n') || parakeetDebugLog.textContent;
  try {
    await navigator.clipboard.writeText(text);
    copyParakeetLogBtn.textContent = 'Copié';
    setTimeout(() => { copyParakeetLogBtn.textContent = 'Copier le journal'; }, 1200);
  } catch {
    parakeetDebugLog.focus();
    window.getSelection()?.selectAllChildren(parakeetDebugLog);
  }
});

function setParakeetPhase(id, label, detail = '') {
  parakeetPhaseId = id || 'unknown';
  parakeetPhaseStartedAt = performance.now();
  parakeetPhase.textContent = `Phase : ${label || id || 'inconnue'}`;
  parakeetPhaseDetail.textContent = detail || '—';
}

setInterval(() => {
  const now = performance.now();
  parakeetPhaseElapsed.textContent = fmtDuration(now - parakeetPhaseStartedAt);
  if (!lastParakeetSignalAt) {
    parakeetHeartbeat.textContent = 'Worker : aucun signal';
    return;
  }
  const age = now - lastParakeetSignalAt;
  if (age > 2500) {
    const hint = parakeetPhaseId === 'recognizer-create'
      ? ' · occupé dans C++/WASM/ONNX Runtime'
      : ' · aucun message du Worker';
    parakeetHeartbeat.textContent = `Worker : dernier signal il y a ${fmtDuration(age)}${hint}`;
  } else {
    parakeetHeartbeat.textContent = `Worker : actif · signal ${fmtDuration(age)}`;
  }
}, 250);

function ensureFileRow(file, label = file) {
  if (parakeetFileRows.has(file)) return parakeetFileRows.get(file);
  const row = document.createElement('div');
  row.className = 'file-diag-row';
  const name = document.createElement('strong');
  name.textContent = label;
  const progress = document.createElement('progress');
  progress.max = 100;
  progress.value = 0;
  const state = document.createElement('span');
  state.className = 'file-state';
  state.textContent = 'en attente';
  row.append(name, progress, state);
  parakeetFiles.append(row);
  const data = { row, name, progress, state };
  parakeetFileRows.set(file, data);
  return data;
}

function resetFileRows() {
  parakeetFiles.replaceChildren();
  parakeetFileRows.clear();
  for (const [file, label] of [
    ['tokens.txt', 'tokens'], ['bpe.vocab', 'BPE vocab'],
    ['encoder.int8.onnx', 'encoder INT8'], ['decoder.int8.onnx', 'decoder INT8'],
    ['joiner.int8.onnx', 'joiner INT8'],
  ]) ensureFileRow(file, label);
}
resetFileRows();

function setParakeetLoading(text, percent = null) {
  if (Number.isFinite(percent)) {
    parakeetProgress.value = Math.max(0, Math.min(100, percent));
  } else {
    parakeetProgress.removeAttribute('value');
  }
  parakeetProgressText.textContent = text;
}
function setParakeetDone(text) {
  parakeetProgress.value = 100;
  parakeetProgressText.textContent = text;
}

function ensureParakeetWorker() {
  if (parakeetWorker) return parakeetWorker;
  const url = new URL('parakeet-worker.js', document.baseURI);
  url.searchParams.set('build', PARAKEET_BUILD);
  appendParakeetLog(`création Worker ${url.href}`);
  parakeetWorker = new Worker(url.href);

  parakeetWorker.onmessage = (e) => {
    const m = e.data || {};
    lastParakeetSignalAt = performance.now();

    if (m.type === 'hello') {
      parakeetRevision = m.revision || 'inconnue';
      appendParakeetLog(`Worker ${parakeetRevision} · CPU logiques ${m.hardwareConcurrency ?? '?'} · crossOriginIsolated=${m.crossOriginIsolated}`);
      if (parakeetRevision !== PARAKEET_BUILD) {
        appendParakeetLog(`VERSION INATTENDUE : page=${PARAKEET_BUILD}, worker=${parakeetRevision}`, 'error');
        setStatus('parakeetStatus', 'mauvaise version Worker', 'error');
      }
    } else if (m.type === 'heartbeat') {
      // No DOM/log spam: receipt time alone feeds the independent page watchdog.
    } else if (m.type === 'phase') {
      setParakeetPhase(m.id, m.label, m.detail);
      appendParakeetLog(`PHASE ${m.id} · ${m.label}${m.detail ? ` · ${m.detail}` : ''}`);
    } else if (m.type === 'status') {
      setStatus('parakeetStatus', m.text || 'chargement…', m.status === 'ready' ? 'ready' : 'busy');
      if (!String(m.text || '').startsWith('téléchargement ')) setParakeetLoading(m.text || 'chargement…');
    } else if (m.type === 'runtime-ready') {
      appendParakeetLog(`runtime WASM prêt · mémoire WASM ${fmtBytes(m.wasmMemoryBytes)} · FS=[${(m.fsBackends || []).join(', ')}]`);
    } else if (m.type === 'runtime-dependencies') {
      appendParakeetLog(`dépendances runtime restantes : ${m.left}`);
    } else if (m.type === 'file-progress') {
      const row = ensureFileRow(m.file, m.label);
      const percent = m.total > 0 ? (m.loaded / m.total) * 100 : null;
      if (Number.isFinite(percent)) row.progress.value = Math.max(0, Math.min(100, percent));
      else row.progress.removeAttribute('value');
      const totalText = m.total ? ` / ${fmtBytes(m.total)}` : '';
      const speed = m.speedBps ? ` · ${fmtBytes(m.speedBps)}/s` : '';
      row.state.textContent = `${fmtBytes(m.loaded)}${totalText}${speed} · ${fmtDuration(m.elapsedMs)}`;
      setParakeetLoading(`${m.label} · ${fmtBytes(m.loaded)}${totalText}`, percent);
    } else if (m.type === 'file-complete') {
      const row = ensureFileRow(m.file, m.label);
      row.progress.value = 100;
      const source = m.timing?.sourceHint || 'source inconnue';
      row.state.textContent = `${fmtBytes(m.bytes)} · ${fmtDuration(m.elapsedMs)} · ${source}`;
      appendParakeetLog(`${m.file} terminé · ${fmtBytes(m.bytes)} · ${fmtDuration(m.elapsedMs)} · ${source}`);
    } else if (m.type === 'mount-check') {
      appendParakeetLog(`WORKERFS OK ${m.path} · ${fmtBytes(m.bytes)}`);
    } else if (m.type === 'model-mounted') {
      appendParakeetLog(`WORKERFS monté · ${fmtBytes(m.bytes)} · montage seul ${fmtDuration(m.mountOnlyMs)}`);
      setParakeetLoading(`poids montés · ${fmtBytes(m.bytes)} · création recognizer…`);
    } else if (m.type === 'recognizer-config') {
      appendParakeetLog(`recognizer: ${m.decodingMethod} · hotwords=${m.hotwordCount} · score=${m.hotwordScore} · mémoire WASM avant=${fmtBytes(m.wasmMemoryBytesBefore)}`);
    } else if (m.type === 'recognizer-created') {
      appendParakeetLog(`recognizer créé · ${fmtDuration(m.elapsedMs)} · mémoire WASM=${fmtBytes(m.wasmMemoryBytesAfter)}`);
    } else if (m.type === 'log') {
      appendParakeetLog(`[${m.source || 'worker'}] ${m.text}`, m.level || 'info');
    } else if (m.type === 'ready') {
      parakeetReady = true;
      setStatus('parakeetStatus', m.mode === 'modified_beam_search' ? 'prêt + hotwords' : 'prêt · greedy', 'ready');
      setParakeetDone(m.mode === 'modified_beam_search' ? 'Prêt · modified_beam_search' : 'Prêt · greedy_search');
      setParakeetPhase('ready', 'Parakeet prêt', m.mode);
      if (m.timings) {
        const t = m.timings;
        $('parakeetInitMetrics').textContent =
          `Initialisation : fichiers ${fmtDuration(t.modelMountMs)} · montage WORKERFS seul ${fmtDuration(t.workerFsMountOnlyMs)} · recognizer ${fmtDuration(t.recognizerMs)} · total ${fmtDuration(t.totalMs)}`;
        appendParakeetLog(`READY · fichiers=${fmtDuration(t.modelMountMs)} · mount=${fmtDuration(t.workerFsMountOnlyMs)} · recognizer=${fmtDuration(t.recognizerMs)} · total=${fmtDuration(t.totalMs)}`);
      }
      parakeetInitResolve?.(m);
      parakeetInitResolve = parakeetInitReject = null;
    } else if (m.type === 'result') {
      parakeetRunResolve?.(m);
      parakeetRunResolve = parakeetRunReject = null;
    } else if (m.type === 'error') {
      const phase = m.phase?.id ? `phase=${m.phase.id} · ${fmtDuration(m.phase.elapsedMs)}` : `phase=${parakeetPhaseId}`;
      console.error('Parakeet worker:', m.message);
      appendParakeetLog(`${phase}\n${m.message}`, 'error');
      setStatus('parakeetStatus', 'erreur', 'error');
      parakeetProgress.value = 0;
      parakeetProgressText.textContent = `Erreur · ${phase}`;
      parakeetPhaseDetail.textContent = m.message || 'Erreur Parakeet';
      parakeetInitReject?.(new Error(m.message));
      parakeetRunReject?.(new Error(m.message));
      parakeetInitResolve = parakeetInitReject = null;
      parakeetRunResolve = parakeetRunReject = null;
    }
  };

  parakeetWorker.onerror = (e) => {
    const message = e.message || 'Le Worker Parakeet s’est arrêté.';
    console.error(e);
    appendParakeetLog(`Worker arrêté · ${message}`, 'error');
    parakeetReady = false;
    setStatus('parakeetStatus', 'worker arrêté', 'error');
    parakeetProgress.value = 0;
    parakeetProgressText.textContent = message;
    parakeetPhaseDetail.textContent = message;
    parakeetInitReject?.(new Error(message));
    parakeetRunReject?.(new Error(message));
    parakeetInitResolve = parakeetInitReject = null;
    parakeetRunResolve = parakeetRunReject = null;
    parakeetWorker = null;
  };
  return parakeetWorker;
}

function resetParakeetWorker(reason = 'réinitialisation manuelle') {
  if (parakeetWorker) {
    try { parakeetWorker.terminate(); } catch {}
  }
  parakeetWorker = null;
  parakeetReady = false;
  lastParakeetSignalAt = 0;
  parakeetInitReject?.(new Error(reason));
  parakeetRunReject?.(new Error(reason));
  parakeetInitResolve = parakeetInitReject = null;
  parakeetRunResolve = parakeetRunReject = null;
  setStatus('parakeetStatus', 'non chargé', 'idle');
  setParakeetPhase('idle', 'Worker arrêté', 'Clique sur « Charger Parakeet » pour repartir proprement.');
  parakeetProgress.value = 0;
  parakeetProgressText.textContent = 'Worker réinitialisé';
  appendParakeetLog(`Worker terminé · ${reason}`, 'warn');
}

resetParakeetWorkerBtn.addEventListener('click', () => resetParakeetWorker());

function currentParakeetConfig() {
  return { hotwords: hotwords.value, hotwordScore: Number(scoreInput.value) || 1.5 };
}

function initParakeet() {
  return new Promise((resolve, reject) => {
    parakeetInitResolve = resolve;
    parakeetInitReject = reject;
    parakeetReady = false;
    resetFileRows();
    setStatus('parakeetStatus', 'chargement…', 'busy');
    setParakeetPhase('worker-start', 'démarrage Parakeet', PARAKEET_BUILD);
    setParakeetLoading('Chargement du petit runtime WASM…');
    appendParakeetLog(`INIT demandé · ${PARAKEET_BUILD}`);
    ensureParakeetWorker().postMessage({ type: 'init', ...currentParakeetConfig() });
  });
}

function runParakeet(audio) {
  return new Promise((resolve, reject) => {
    parakeetRunResolve = resolve;
    parakeetRunReject = reject;
    const c = audio.slice();
    ensureParakeetWorker().postMessage({ type: 'transcribe', audio: c.buffer, ...currentParakeetConfig() }, [c.buffer]);
  });
}

initParakeetBtn.addEventListener('click', async () => {
  initParakeetBtn.disabled = true;
  try {
    await initParakeet();
    $('parakeetDetail').textContent = 'ONNX, tokens et BPE sont servis séparément et montés en lecture seule via WORKERFS ; aucun bundle Emscripten .data n’est chargé. Le diagnostic reste visible ci-dessus.';
  } catch (e) {
    $('parakeetDetail').textContent = `Échec Parakeet : ${e.message}. Consulte le journal de diagnostic juste au-dessus.`;
  } finally {
    initParakeetBtn.disabled = false;
  }
});

for (const el of [hotwords, scoreInput]) {
  el.addEventListener('input', () => {
    if (parakeetReady) {
      setStatus('parakeetStatus', 'hotwords modifiés', 'idle');
      parakeetProgressText.textContent = 'La nouvelle configuration sera appliquée au prochain test.';
    }
  });
}


recordBtn.addEventListener('click', () => startRecording().catch((e) => alert(e.message)));
stopBtn.addEventListener('click', () => stopRecording().catch((e) => alert(e.message)));

runBtn.addEventListener('click', async () => {
  if (!currentAudio) return;
  runBtn.disabled = true;
  const duration = currentAudio.length / 16000;
  const jobs = [];

  $('whisperText').textContent = '…';
  setStatus('whisperStatus', 'inférence…', 'busy');
  jobs.push(runWhisper(currentAudio).then((r) => {
    $('whisperText').textContent = r.text || '(vide)';
    $('whisperTime').textContent = `${(r.elapsedMs / 1000).toFixed(2)} s`;
    $('whisperRtf').textContent = (r.elapsedMs / 1000 / duration).toFixed(3);
    setStatus('whisperStatus', 'prêt', 'ready');
  }).catch((e) => {
    $('whisperText').textContent = e.message;
    setStatus('whisperStatus', 'erreur', 'error');
  }));

  if (parakeetReady) {
    $('parakeetText').textContent = '…';
    setStatus('parakeetStatus', 'inférence…', 'busy');
    jobs.push(runParakeet(currentAudio).then((r) => {
      $('parakeetText').textContent = r.text || '(vide)';
      $('parakeetTime').textContent = `${(r.elapsedMs / 1000).toFixed(2)} s`;
      $('parakeetRtf').textContent = (r.elapsedMs / 1000 / duration).toFixed(3);
      setStatus('parakeetStatus', r.mode === 'modified_beam_search' ? 'prêt + hotwords' : 'prêt · greedy', 'ready');
    }).catch((e) => {
      $('parakeetText').textContent = e.message;
      setStatus('parakeetStatus', 'erreur', 'error');
    }));
  } else {
    $('parakeetText').textContent = 'Parakeet non chargé — clique d’abord sur « Charger Parakeet ».';
  }

  await Promise.allSettled(jobs);
  runBtn.disabled = false;
});
