import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;
// For a reproducible CPU comparison with sherpa-onnx WASM, stay single-threaded.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
}

let transcriber = null;

async function load() {
  if (transcriber) return;
  self.postMessage({ type: 'status', status: 'loading', text: 'chargement…' });
  transcriber = await pipeline(
    'automatic-speech-recognition',
    'Xenova/whisper-base.en',
    {
      dtype: 'fp32',
      device: 'wasm',
      progress_callback: (p) => {
        if (p?.status === 'progress' && Number.isFinite(p.progress)) {
          self.postMessage({ type: 'progress', progress: p.progress });
        }
      },
    }
  );
  self.postMessage({ type: 'status', status: 'ready', text: 'prêt' });
}

self.onmessage = async (event) => {
  const { type } = event.data || {};
  try {
    if (type === 'load') {
      await load();
      return;
    }
    if (type === 'transcribe') {
      await load();
      const audio = new Float32Array(event.data.audio);
      const t0 = performance.now();
      const out = await transcriber(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const elapsedMs = performance.now() - t0;
      self.postMessage({ type: 'result', text: out?.text?.trim() || '', elapsedMs });
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.stack || error?.message || String(error) });
  }
};
