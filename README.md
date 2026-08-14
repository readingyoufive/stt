# Whisper base.en FP32 vs Parakeet-TDT v2 INT8 + Hotwords

Démo 100 % navigateur pour comparer le même enregistrement micro entre :

- **Whisper `base.en` FP32** via Transformers.js / ONNX Runtime WebAssembly
- **NVIDIA Parakeet-TDT 0.6B v2 INT8** via **sherpa-onnx v1.13.5 WebAssembly**
- Parakeet utilise **`modified_beam_search` + contextual biasing** lorsque la liste de hotwords n'est pas vide.

## Mise en ligne — la procédure courte

1. Crée ou ouvre ton dépôt GitHub.
2. Dépose **tout le contenu de cette archive à la racine**, y compris le dossier caché `.github`.
3. Commit/push sur la branche `main`.
4. Dans GitHub : **Settings → Pages → Source = GitHub Actions**.
5. Ouvre l'onglet **Actions** et laisse le workflow `Build STT demo and deploy Pages` se terminer.
6. L'URL du site apparaît dans le job `deploy` et dans **Settings → Pages**.

Tu n'installes **ni CMake, ni Emscripten, ni sherpa-onnx** sur ton PC.

## Ce que GitHub Actions fait

Au premier build :

1. récupère `k2-fsa/sherpa-onnx` **v1.13.5** ;
2. récupère le modèle officiel sherpa `sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` ;
3. prépare `bpe.vocab` avec les scores SentencePiece exacts nécessaires aux hotwords ;
4. installe **Emscripten 4.0.23**, version recommandée par le script WASM sherpa-onnx v1.13.5 ;
5. compile le target officiel `build-wasm-simd-vad-asr.sh` ;
6. met le runtime + Parakeet dans `public/parakeet-sherpa/` ;
7. construit Vite ;
8. publie `dist/` sur GitHub Pages.

Le bundle compilé est ensuite conservé dans le **cache GitHub Actions**. Tant que la clé de cache n'est pas changée, les builds suivants réutilisent le runtime au lieu de recompiler sherpa-onnx.

## Hotwords

Dans l'interface, mets un mot ou une expression par ligne :

```text
KUBERNETES
POSTGRESQL
OPENAI
CLOUDFLARE
MCALLISTER
```

Avec une liste non vide, la configuration Parakeet est :

```text
model_type      = nemo_transducer
modeling_unit   = bpe
bpe_vocab       = ./bpe.vocab
decoding_method = modified_beam_search
hotwords_file   = ./hotwords.txt
hotwords_score  = 1.5
max_active_paths = 4
```

Si tu effaces tous les hotwords, Parakeet bascule en `greedy_search`.

## Confidentialité

Le micro est capturé par Web Audio et la transcription s'effectue dans le navigateur. Cette démo n'envoie pas l'audio à un service STT distant.

- Whisper télécharge ses poids depuis Hugging Face au chargement.
- Le bundle Parakeet/sherpa est servi par ton GitHub Pages et peut être mis en cache par le navigateur.

## Taille

Le modèle Parakeet INT8 est d'environ **661 MB** sur Hugging Face. Le fichier `.data` WebAssembly publié sur Pages contient les poids et quelques petits assets supplémentaires.

GitHub Pages convient pour une démo ou un usage modéré. Pour un site à fort trafic, il sera préférable de déplacer le gros `.data` vers un stockage/CDN adapté.

## Dépannage

### Le workflow ne démarre pas

Vérifie que le fichier suivant est bien présent dans GitHub :

```text
.github/workflows/pages.yml
```

et que le push est effectué sur `main`.

### Pages renvoie 404

Dans **Settings → Pages**, sélectionne **GitHub Actions** comme source. Le workflow utilise des URLs relatives et fonctionne aussi bien sur `https://user.github.io/repo/` que sur un domaine personnalisé.

### Parakeet reste sur « chargement »

Ouvre DevTools → Network et vérifie que ces fichiers répondent en 200 :

```text
parakeet-sherpa/sherpa-onnx-asr.js
parakeet-sherpa/sherpa-onnx-wasm-main-vad-asr.js
parakeet-sherpa/sherpa-onnx-wasm-main-vad-asr.wasm
parakeet-sherpa/sherpa-onnx-wasm-main-vad-asr.data
```

### Le runtime doit être reconstruit

Dans `.github/workflows/pages.yml`, change le suffixe de cette clé :

```yaml
key: parakeet-wasm-${{ env.SHERPA_VERSION }}-tdt-v2-int8-hotwords-v1
```

par exemple `...-v2`. Le prochain workflow reconstruira le WASM au lieu de reprendre le cache.

## Versions figées

- sherpa-onnx : **v1.13.5**
- Emscripten : **4.0.23**
- Parakeet : **nvidia/parakeet-tdt-0.6b-v2**, conversion sherpa INT8
- `@huggingface/transformers` : **3.8.1**
- Vite : **7.1.2**

Voir aussi `THIRD_PARTY_NOTICES.md`.
