# Whisper base.en FP32 vs Parakeet-TDT v2 INT8 + Hotwords — v10.1 WORKERFS

Démo 100 % navigateur pour comparer le même enregistrement micro entre :

- **Whisper `base.en` FP32** via Transformers.js / ONNX Runtime WebAssembly ;
- **NVIDIA Parakeet-TDT 0.6B v2 INT8** via **sherpa-onnx v1.13.5 WebAssembly** ;
- Parakeet utilise **`modified_beam_search` + contextual biasing** lorsque la liste de hotwords n'est pas vide.

## Ce qui change en v10.1

Les gros graphes Parakeet ne sont **plus intégrés dans le `.data` Emscripten**.

Ancienne architecture :

```text
~630 MB ONNX
   ↓
--preload-file
   ↓
gros .data Emscripten
   ↓
MEMFS en RAM
   ↓
ONNX Runtime
```

Nouvelle architecture :

```text
petit .data
  ├─ tokens.txt
  ├─ bpe.vocab
  └─ silero_vad.onnx

encoder.int8.onnx ─┐
decoder.int8.onnx ─┼─ fetch/cache navigateur → Blob → WORKERFS → sherpa/ORT
joiner.int8.onnx  ─┘
```

`WORKERFS` donne au code WASM un accès en lecture seule à des `Blob` depuis un Web Worker sans recopier tout le fichier dans MEMFS. Le coût de création des sessions ONNX reste présent, mais on supprime le gros passage `.data → MEMFS` des poids.

La page affiche maintenant séparément :

- montage/ouverture du modèle externe ;
- création du recognizer ;
- temps total d'initialisation.

## Mise en ligne

1. Crée ou ouvre ton dépôt GitHub.
2. Dépose **tout le contenu de cette archive à la racine**, y compris `.github`.
3. Commit/push sur `main`.
4. Dans GitHub : **Settings → Pages → Source = GitHub Actions**.
5. Ouvre **Actions** et attends la fin de `Build STT demo and deploy Pages`.
6. L'URL du site apparaît dans le job `deploy` et dans **Settings → Pages**.

Tu n'installes ni CMake, ni Emscripten, ni sherpa-onnx sur ton PC.

## Ce que GitHub Actions fait

Au premier build :

1. télécharge le modèle officiel sherpa `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` ;
2. conserve `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` dans un cache de modèle séparé ;
3. récupère `k2-fsa/sherpa-onnx` **v1.13.5** ;
4. génère `bpe.vocab` avec le tokenizer SentencePiece exact ;
5. installe **Emscripten 4.0.23** ;
6. patche uniquement le target WASM pour exporter `FS` + `WORKERFS` et linker `workerfs.js` ;
7. compile sherpa-onnx ;
8. vérifie que le `.data` généré reste **< 50 MB** ;
9. publie le runtime dans `public/parakeet-sherpa/` ;
10. publie les poids séparément dans `public/parakeet-model/` ;
11. construit Vite et déploie GitHub Pages.

Le runtime compilé et les poids sont mis en cache séparément dans GitHub Actions.

## Arborescence publiée

```text
/parakeet-sherpa/
  sherpa-onnx-asr.js
  sherpa-onnx-wasm-main-vad-asr.js
  sherpa-onnx-wasm-main-vad-asr.wasm
  sherpa-onnx-wasm-main-vad-asr.data   # petit

/parakeet-model/
  encoder.int8.onnx                     # ~gros fichier
  decoder.int8.onnx
  joiner.int8.onnx
```

Le worker charge les trois ONNX avec `fetch(..., { cache: 'force-cache' })`, les transforme en `Blob`, puis monte ces blobs dans `/models` avec WORKERFS.

## Hotwords

Un mot ou une expression par ligne :

```text
KUBERNETES
POSTGRESQL
OPENAI
CLOUDFLARE
MCALLISTER
```

Avec une liste non vide :

```text
model_type       = nemo_transducer
modeling_unit    = bpe
bpe_vocab        = ./bpe.vocab
decoding_method  = modified_beam_search
hotwords_file    = ./hotwords.txt
hotwords_score   = 1.5
max_active_paths = 4
```

Sans hotwords, Parakeet utilise `greedy_search`.

## Important : ce que cette optimisation améliore et ce qu'elle n'améliore pas

Cette v10.1 vise surtout :

- moins de copies mémoire avant l'ouverture des modèles ;
- un `.data` beaucoup plus petit ;
- moins de pression MEMFS ;
- une meilleure visibilité sur le temps réellement passé dans la création du recognizer.

Elle **ne supprime pas** :

- la lecture des ~630 MB par ONNX Runtime ;
- le parsing/optimisation des graphes ;
- l'allocation des poids et buffers ;
- le coût de création de `OfflineRecognizer`.

Sur mobile, compare surtout les timings affichés par la page avant/après cette version.

## Confidentialité

Le micro et la transcription restent dans le navigateur. Aucun audio n'est envoyé à un service STT distant.

## Dépannage

### WORKERFS n'est pas exposé

Si tu vois :

```text
WORKERFS n’est pas exposé
```

force une reconstruction du runtime en changeant la clé :

```yaml
key: parakeet-wasm-${{ env.SHERPA_VERSION }}-workerfs-v10.1
```

par exemple en `...-v10.1b`.

### Les modèles externes font 404

Vérifie dans DevTools → Network :

```text
parakeet-model/encoder.int8.onnx
parakeet-model/decoder.int8.onnx
parakeet-model/joiner.int8.onnx
```

### Le `.data` est encore énorme

Le workflow contient une garde :

```text
.data < 50 MB
```

Si elle échoue, les poids ont probablement été réintroduits dans `wasm/vad-asr/assets`.

## Versions figées

- sherpa-onnx : **v1.13.5**
- Emscripten : **4.0.23**
- Parakeet : **nvidia/parakeet-tdt-0.6b-v2**, conversion sherpa INT8
- `@huggingface/transformers` : **3.8.1**
- Vite : **7.1.2**

Voir également `THIRD_PARTY_NOTICES.md`.


## v10.1 — correction WORKERFS

La v10.1 résout WORKERFS via `FS.filesystems.WORKERFS` (chemin canonique du legacy FS Emscripten), force un rebuild du runtime et vérifie pendant GitHub Actions que `WORKERFS` est réellement présent dans le JS généré. Après déploiement, faire un rechargement forcé du site pour éviter un ancien `parakeet-worker.js` en cache.
