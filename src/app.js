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
let parakeetWorker = null;
let parakeetReady = false;
let parakeetInitResolve = null;
let parakeetInitReject = null;
let parakeetRunResolve = null;
let parakeetRunReject = null;

function setParakeetLoading(text) {
  parakeetProgress.removeAttribute('value');
  parakeetProgressText.textContent = text;
}
function setParakeetDone(text) {
  parakeetProgress.value = 100;
  parakeetProgressText.textContent = text;
}

function ensureParakeetWorker() {
  if (parakeetWorker) return parakeetWorker;
  const url = new URL('parakeet-worker.js', document.baseURI).href;
  parakeetWorker = new Worker(url);

  parakeetWorker.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'status') {
      setStatus('parakeetStatus', m.text || 'chargement…', m.status === 'ready' ? 'ready' : 'busy');
      setParakeetLoading(m.text || 'chargement…');
    } else if (m.type === 'runtime-ready') {
      setParakeetLoading('runtime WASM prêt · ouverture des poids ONNX externes…');
    } else if (m.type === 'model-mounted') {
      const mb = m.bytes ? (m.bytes / 1024 / 1024).toFixed(0) : '?';
      setParakeetLoading(`poids ONNX montés via WORKERFS · ${mb} MB · création du recognizer…`);
    } else if (m.type === 'ready') {
      parakeetReady = true;
      setStatus('parakeetStatus', m.mode === 'modified_beam_search' ? 'prêt + hotwords' : 'prêt · greedy', 'ready');
      setParakeetDone(m.mode === 'modified_beam_search' ? 'Prêt · modified_beam_search' : 'Prêt · greedy_search');
      if (m.timings) {
        const t = m.timings;
        $('parakeetInitMetrics').textContent =
          `Initialisation : modèle externe ${(t.modelMountMs / 1000).toFixed(1)} s · recognizer ${(t.recognizerMs / 1000).toFixed(1)} s · total ${(t.totalMs / 1000).toFixed(1)} s`;
      }
      parakeetInitResolve?.(m);
      parakeetInitResolve = parakeetInitReject = null;
    } else if (m.type === 'result') {
      parakeetRunResolve?.(m);
      parakeetRunResolve = parakeetRunReject = null;
    } else if (m.type === 'error') {
      console.error('Parakeet worker:', m.message);
      setStatus('parakeetStatus', 'erreur', 'error');
      parakeetProgress.value = 0;
      parakeetProgressText.textContent = m.message || 'Erreur Parakeet';
      parakeetInitReject?.(new Error(m.message));
      parakeetRunReject?.(new Error(m.message));
      parakeetInitResolve = parakeetInitReject = null;
      parakeetRunResolve = parakeetRunReject = null;
    }
  };

  parakeetWorker.onerror = (e) => {
    const message = e.message || 'Le Worker Parakeet s’est arrêté.';
    console.error(e);
    parakeetReady = false;
    setStatus('parakeetStatus', 'worker arrêté', 'error');
    parakeetProgress.value = 0;
    parakeetProgressText.textContent = message;
    parakeetInitReject?.(new Error(message));
    parakeetRunReject?.(new Error(message));
    parakeetInitResolve = parakeetInitReject = null;
    parakeetRunResolve = parakeetRunReject = null;
    parakeetWorker = null;
  };
  return parakeetWorker;
}

function currentParakeetConfig() {
  return { hotwords: hotwords.value, hotwordScore: Number(scoreInput.value) || 1.5 };
}

function initParakeet() {
  return new Promise((resolve, reject) => {
    parakeetInitResolve = resolve;
    parakeetInitReject = reject;
    parakeetReady = false;
    setStatus('parakeetStatus', 'chargement…', 'busy');
    setParakeetLoading('Chargement du petit runtime WASM…');
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
    $('parakeetDetail').textContent = 'ONNX, tokens et BPE sont servis séparément et montés en lecture seule via WORKERFS ; aucun bundle Emscripten .data n’est chargé. L’audio reste local.';
  } catch (e) {
    $('parakeetDetail').textContent = e.message;
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
