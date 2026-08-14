# v8 — Whisper base.en FP32 vs Parakeet-TDT 0.6B v2 INT8 + hotwords

Cette version supprime **CMake, Ninja, Emscripten et toute compilation sherpa-onnx côté utilisateur**.

## Architecture

- **Whisper base.en FP32** : `@huggingface/transformers` + ONNX Runtime Web/WASM.
- **Parakeet-TDT 0.6B v2 INT8** : graphes ONNX préconvertis publiés par `csukuangfj`/sherpa-onnx sur Hugging Face.
- **Runtime sherpa-onnx navigateur** : runtime WebAssembly précompilé distribué par `@siteed/sherpa-onnx.rn` via jsDelivr.
- **Hotwords** : `modified_beam_search`, `modeling_unit=bpe`, `hotwords_file` et `bpe.vocab`.
- Le micro et l'inférence restent dans le navigateur. Internet sert à télécharger le runtime et les poids.

## Déploiement recommandé : GitHub Pages

1. Crée un dépôt GitHub et copie le contenu de ce dossier à la racine.
2. Pousse sur la branche `main`.
3. Dans **Settings → Pages**, sélectionne **GitHub Actions** comme source.
4. Le workflow `.github/workflows/pages.yml` construit et publie automatiquement le site.

Le premier workflow télécharge le checkpoint NVIDIA `.nemo` pour extraire **exactement** son tokenizer et générer `public/parakeet/bpe.vocab`. Ce fichier est ensuite mis en cache par GitHub Actions. **Il n'y a aucune compilation de sherpa-onnx.**

Pourquoi ce détour ? Le dépôt INT8 sherpa-onnx contient `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` et `tokens.txt`, mais pas le `bpe.vocab` requis pour encoder les hotwords English/BPE.

## Test local

Double-clique `run-demo.bat` ou lance :

```bash
npm install
npm run dev
```

Puis ouvre `http://localhost:5173`.

**Important :** le contextual biasing Parakeet nécessite `public/parakeet/bpe.vocab`. Le workflow GitHub Pages le produit automatiquement. Pour un test local complet, récupère ce petit fichier depuis l'artefact/site généré et place-le dans `public/parakeet/bpe.vocab`. Sans lui, Whisper fonctionne mais le bouton Parakeet affiche une erreur explicite.

## Téléchargements navigateur

Au premier chargement Parakeet :

- encoder INT8 : ~652 MB
- decoder INT8 : ~7 MB
- joiner INT8 : ~1.7 MB
- tokens + bpe vocab : négligeables
- runtime WASM : chargé depuis jsDelivr

Le navigateur/CDN peut réutiliser le cache HTTP lors des visites suivantes. Le modèle est tout de même recopié dans la mémoire WASM à chaque nouvelle session de page.

## Hotwords

Un mot ou une expression par ligne, par exemple :

```text
KUBERNETES
POSTGRESQL
OPENAI
JOHN MCALLISTER
```

Sherpa-onnx documente que les hotwords des modèles Transducer utilisent `modified_beam_search`. Pour les modèles English/BPE, `modeling-unit=bpe` et `bpe-vocab` sont requis.

## Versions figées

- `@huggingface/transformers`: 3.8.1
- Vite: 7.1.2
- runtime CDN: `@siteed/sherpa-onnx.rn@1.3.0` (runtime sherpa-onnx 1.13.0 déclaré par ce wrapper)
- Parakeet: `nvidia/parakeet-tdt-0.6b-v2`, export INT8 sherpa-onnx

## Limite connue

Le runtime browser précompilé tiers est choisi pour supprimer le build Emscripten local. Le support de hotwords Parakeet/NeMo-TDT dans sherpa-onnx est relativement récent ; garde donc ce chemin marqué expérimental et teste-le avec tes propres audios/hotwords avant production.
