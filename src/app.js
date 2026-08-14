const $ = (id) => document.getElementById(id);
const setStatus = (id, text, cls = 'idle') => { const e=$(id); e.textContent=text; e.className=`status ${cls}`; };

const recordBtn=$('recordBtn'), stopBtn=$('stopBtn'), runBtn=$('runBtn'), playback=$('playback');
const timer=$('timer'), level=$('level'), hotwords=$('hotwords'), scoreInput=$('parakeetHotwordScore');
const initParakeetBtn=$('initParakeetBtn'), parakeetProgress=$('parakeetProgress'), parakeetProgressText=$('parakeetProgressText');

let audioContext, mediaStream, sourceNode, workletNode, recordingStartedAt=0, timerId;
let inputChunks=[], inputSampleRate=48000, currentAudio=null, currentAudioUrl=null;

function concatFloat32(chunks){const n=chunks.reduce((a,c)=>a+c.length,0);const out=new Float32Array(n);let o=0;for(const c of chunks){out.set(c,o);o+=c.length;}return out;}
function downsampleBuffer(buffer,inputRate,outputRate=16000){if(inputRate===outputRate)return new Float32Array(buffer);const ratio=inputRate/outputRate;const n=Math.floor(buffer.length/ratio);const out=new Float32Array(n);for(let i=0;i<n;i++){const a=Math.floor(i*ratio),b=Math.min(buffer.length,Math.floor((i+1)*ratio));let s=0,c=0;for(let j=a;j<b;j++){s+=buffer[j];c++;}out[i]=c?s/c:0;}return out;}
function wavBlob(samples,sr=16000){const buf=new ArrayBuffer(44+samples.length*2),v=new DataView(buf);const w=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));w(0,'RIFF');v.setUint32(4,36+samples.length*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,samples.length*2,true);let o=44;for(const x of samples){const s=Math.max(-1,Math.min(1,x));v.setInt16(o,s<0?s*0x8000:s*0x7fff,true);o+=2;}return new Blob([v],{type:'audio/wav'});}

async function startRecording(){
  if(!window.isSecureContext) throw new Error(`Le micro nécessite HTTPS ou http://localhost. URL actuelle : ${location.href}`);
  if(!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia indisponible dans ce navigateur/contexte.');
  mediaStream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  const AudioCtx=window.AudioContext||window.webkitAudioContext; audioContext=new AudioCtx(); inputSampleRate=audioContext.sampleRate;
  await audioContext.audioWorklet.addModule(new URL('pcm-capture-worklet.js', document.baseURI).href);
  sourceNode=audioContext.createMediaStreamSource(mediaStream);
  workletNode=new AudioWorkletNode(audioContext,'pcm-capture',{numberOfInputs:1,numberOfOutputs:0,channelCount:1});
  inputChunks=[];
  workletNode.port.onmessage=(e)=>{const raw=new Float32Array(e.data);inputChunks.push(raw);let rms=0;for(let i=0;i<raw.length;i++)rms+=raw[i]*raw[i];rms=Math.sqrt(rms/raw.length);level.style.width=`${Math.min(100,rms*420)}%`;};
  sourceNode.connect(workletNode); recordingStartedAt=performance.now();
  timerId=setInterval(()=>timer.textContent=`${((performance.now()-recordingStartedAt)/1000).toFixed(1)} s`,100);
  recordBtn.disabled=true; stopBtn.disabled=false; runBtn.disabled=true;
}
async function stopRecording(){
  clearInterval(timerId); try{sourceNode?.disconnect();workletNode?.disconnect();}catch{} mediaStream?.getTracks().forEach(t=>t.stop()); await audioContext?.close();
  currentAudio=downsampleBuffer(concatFloat32(inputChunks),inputSampleRate,16000); const d=currentAudio.length/16000; timer.textContent=`${d.toFixed(1)} s`;level.style.width='0%';
  if(currentAudioUrl)URL.revokeObjectURL(currentAudioUrl);currentAudioUrl=URL.createObjectURL(wavBlob(currentAudio));playback.src=currentAudioUrl;
  recordBtn.disabled=false;stopBtn.disabled=true;runBtn.disabled=currentAudio.length<1600;$('whisperAudio').textContent=`${d.toFixed(2)} s`;$('parakeetAudio').textContent=`${d.toFixed(2)} s`;
}

// Whisper --------------------------------------------------------------------
const whisperWorker=new Worker(new URL('./whisper-worker.js',import.meta.url),{type:'module'});let whisperResolve,whisperReject;
whisperWorker.onmessage=(e)=>{const m=e.data||{};if(m.type==='progress')setStatus('whisperStatus',`chargement ${Math.round(m.progress)}%`,'busy');else if(m.type==='status')setStatus('whisperStatus',m.text,m.status==='ready'?'ready':'busy');else if(m.type==='result'){whisperResolve?.(m);whisperResolve=whisperReject=null;}else if(m.type==='error'){setStatus('whisperStatus','erreur','error');whisperReject?.(new Error(m.message));whisperResolve=whisperReject=null;}};
whisperWorker.postMessage({type:'load'});
function runWhisper(audio){return new Promise((resolve,reject)=>{whisperResolve=resolve;whisperReject=reject;const c=audio.slice();whisperWorker.postMessage({type:'transcribe',audio:c.buffer},[c.buffer]);});}

// Parakeet v2 INT8 — prebuilt browser WASM ----------------------------------
const SHERPA_WASM_BASE='https://cdn.jsdelivr.net/npm/@siteed/sherpa-onnx.rn@1.3.0/wasm/';
const MODEL_BASE='https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/resolve/main';
const MODEL_DIR='/parakeet-v2';
let sherpaReady=false, parakeetFilesReady=false, parakeetRecognizer=null, recognizerFingerprint='';

function setParakeetProgress(value,text){parakeetProgress.value=Math.max(0,Math.min(100,value));parakeetProgressText.textContent=text;}
function scriptOnce(url){return new Promise((resolve,reject)=>{const found=[...document.scripts].find(s=>s.src===url);if(found){if(found.dataset.loaded==='1')return resolve();found.addEventListener('load',resolve,{once:true});found.addEventListener('error',()=>reject(new Error(`Impossible de charger ${url}`)),{once:true});return;}const s=document.createElement('script');s.src=url;s.async=false;s.onload=()=>{s.dataset.loaded='1';resolve();};s.onerror=()=>reject(new Error(`Impossible de charger ${url}`));document.head.appendChild(s);});}
async function waitUntil(test,timeout=180000){const t0=performance.now();while(!test()){if(performance.now()-t0>timeout)throw new Error('Timeout pendant le chargement du runtime sherpa-onnx.');await new Promise(r=>setTimeout(r,200));}}
async function loadSherpaRuntime(){
  if(sherpaReady)return;
  setStatus('parakeetStatus','runtime WASM…','busy');setParakeetProgress(4,'Runtime WASM depuis jsDelivr…');
  window._sherpaOnnxProgressCallback=(e)=>{if(e?.phase==='module'){const pct=5+Math.round((e.loaded/Math.max(1,e.total))*10);setParakeetProgress(pct,`Modules sherpa ${e.loaded}/${e.total}`);}};
  await scriptOnce(`${SHERPA_WASM_BASE}sherpa-onnx-wasm-combined.js`);
  const ready=new Promise((resolve)=>{const old=window.onSherpaOnnxReady;window.onSherpaOnnxReady=(ok)=>{try{old?.(ok);}catch{} resolve(!!ok);};});
  await scriptOnce(`${SHERPA_WASM_BASE}sherpa-onnx-combined.js`);
  await Promise.race([ready,new Promise(r=>setTimeout(()=>r(false),15000))]);
  await waitUntil(()=>window.Module?.FS&&window.SherpaOnnx?.FileSystem&&typeof window.OfflineRecognizer==='function');
  sherpaReady=true;setParakeetProgress(15,'Runtime prêt');
}
function ensureDir(path){try{if(!window.Module.FS.analyzePath(path).exists)window.Module.FS.mkdir(path);}catch{}}
async function loadFsFile(url,fsPath,label,progress){
  try{if(window.Module.FS.analyzePath(fsPath).exists){setParakeetProgress(progress,`${label} déjà en mémoire`);return;}}catch{}
  setParakeetProgress(progress,`${label}…`);
  const result=await window.SherpaOnnx.FileSystem.safeLoadFile(url,fsPath,0);if(!result)throw new Error(`Échec du chargement : ${label}`);
}
async function loadParakeetFiles(){
  if(parakeetFilesReady)return;ensureDir(MODEL_DIR);
  const bpeUrl=new URL('parakeet/bpe.vocab',document.baseURI).href;
  const bpeCheck=await fetch(bpeUrl,{method:'HEAD',cache:'no-store'}).catch(()=>null);
  if(!bpeCheck?.ok)throw new Error('bpe.vocab absent. Sur GitHub Pages, laisse le workflow fourni le générer. Voir README.md.');
  await loadFsFile(`${MODEL_BASE}/tokens.txt`,`${MODEL_DIR}/tokens.txt`,'tokens.txt',20);
  await loadFsFile(bpeUrl,`${MODEL_DIR}/bpe.vocab`,'bpe.vocab hotwords',25);
  await loadFsFile(`${MODEL_BASE}/decoder.int8.onnx`,`${MODEL_DIR}/decoder.int8.onnx`,'decoder INT8 (~7 MB)',30);
  await loadFsFile(`${MODEL_BASE}/joiner.int8.onnx`,`${MODEL_DIR}/joiner.int8.onnx`,'joiner INT8 (~2 MB)',35);
  await loadFsFile(`${MODEL_BASE}/encoder.int8.onnx`,`${MODEL_DIR}/encoder.int8.onnx`,'encoder INT8 (~652 MB)',45);
  parakeetFilesReady=true;setParakeetProgress(88,'Modèle chargé en mémoire WASM');
}
function normalizedHotwords(){return hotwords.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).join('\n')+'\n';}
function createParakeetRecognizer(){
  const score=Number(scoreInput.value)||1.5;const text=normalizedHotwords();const fp=`${score}|${text}`;if(parakeetRecognizer&&fp===recognizerFingerprint)return;
  try{parakeetRecognizer?.free?.();}catch{} parakeetRecognizer=null;
  window.Module.FS.writeFile(`${MODEL_DIR}/hotwords.txt`,text);
  const cfg={
    featConfig:{sampleRate:16000,featureDim:80},
    modelConfig:{
      transducer:{encoder:`${MODEL_DIR}/encoder.int8.onnx`,decoder:`${MODEL_DIR}/decoder.int8.onnx`,joiner:`${MODEL_DIR}/joiner.int8.onnx`},
      tokens:`${MODEL_DIR}/tokens.txt`,numThreads:1,debug:0,provider:'cpu',modelType:'nemo_transducer',modelingUnit:'bpe',bpeVocab:`${MODEL_DIR}/bpe.vocab`
    },
    lmConfig:{model:'',scale:0},decodingMethod:'modified_beam_search',maxActivePaths:4,hotwordsFile:`${MODEL_DIR}/hotwords.txt`,hotwordsScore:score,blankPenalty:0,debug:0
  };
  setParakeetProgress(92,'Création du recognizer modified_beam_search…');
  parakeetRecognizer=new window.OfflineRecognizer(cfg,window.Module);recognizerFingerprint=fp;
  if(!parakeetRecognizer?.handle)throw new Error('Le recognizer Parakeet n’a pas pu être créé.');
  setParakeetProgress(100,`Prêt · ${text.trim().split('\n').filter(Boolean).length} hotword(s) · score ${score.toFixed(2)}`);
}
async function initParakeet(){
  initParakeetBtn.disabled=true;setStatus('parakeetStatus','initialisation…','busy');
  try{await loadSherpaRuntime();await loadParakeetFiles();createParakeetRecognizer();setStatus('parakeetStatus','prêt + hotwords','ready');$('parakeetDetail').textContent='Runtime précompilé + modèle Hugging Face chargés. Modifier les hotwords reconstruit seulement le recognizer, sans retélécharger les poids.';}
  catch(e){console.error(e);setStatus('parakeetStatus','erreur','error');setParakeetProgress(parakeetProgress.value,e.message);$('parakeetDetail').textContent=e.message;}
  finally{initParakeetBtn.disabled=false;}
}
async function runParakeet(audio){if(!parakeetFilesReady)throw new Error('Charge Parakeet d’abord.');createParakeetRecognizer();const stream=parakeetRecognizer.createStream();try{stream.acceptWaveform(16000,audio);const t0=performance.now();parakeetRecognizer.decode(stream);const elapsedMs=performance.now()-t0;const r=parakeetRecognizer.getResult(stream);return{text:String(r?.text||'').trim(),elapsedMs};}finally{stream.free();}}

initParakeetBtn.addEventListener('click',initParakeet);
hotwords.addEventListener('input',()=>{if(parakeetRecognizer){recognizerFingerprint='';setStatus('parakeetStatus','hotwords modifiés','idle');}});
scoreInput.addEventListener('change',()=>{if(parakeetRecognizer){recognizerFingerprint='';setStatus('parakeetStatus','score modifié','idle');}});
recordBtn.addEventListener('click',()=>startRecording().catch(e=>alert(e.message)));stopBtn.addEventListener('click',()=>stopRecording().catch(e=>alert(e.message)));
runBtn.addEventListener('click',async()=>{
 if(!currentAudio)return;runBtn.disabled=true;const duration=currentAudio.length/16000;const jobs=[];
 $('whisperText').textContent='…';setStatus('whisperStatus','inférence…','busy');jobs.push(runWhisper(currentAudio).then(r=>{$('whisperText').textContent=r.text||'(vide)';$('whisperTime').textContent=`${(r.elapsedMs/1000).toFixed(2)} s`;$('whisperRtf').textContent=(r.elapsedMs/1000/duration).toFixed(3);setStatus('whisperStatus','prêt','ready');}).catch(e=>{$('whisperText').textContent=e.message;setStatus('whisperStatus','erreur','error');}));
 if(parakeetFilesReady){$('parakeetText').textContent='…';setStatus('parakeetStatus','inférence…','busy');jobs.push(runParakeet(currentAudio).then(r=>{$('parakeetText').textContent=r.text||'(vide)';$('parakeetTime').textContent=`${(r.elapsedMs/1000).toFixed(2)} s`;$('parakeetRtf').textContent=(r.elapsedMs/1000/duration).toFixed(3);setStatus('parakeetStatus','prêt + hotwords','ready');}).catch(e=>{$('parakeetText').textContent=e.message;setStatus('parakeetStatus','erreur','error');}));}else{$('parakeetText').textContent='Parakeet non chargé — ignoré.';}
 await Promise.allSettled(jobs);runBtn.disabled=false;
});
