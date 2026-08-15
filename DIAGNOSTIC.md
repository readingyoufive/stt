# Diagnostic Parakeet v10.7

La page affiche maintenant la phase active, sa durée et l'âge du dernier signal du Web Worker.

Ordre attendu :

1. runtime WASM
2. tokens.txt
3. bpe.vocab
4. encoder.int8.onnx (le gros fichier)
5. decoder.int8.onnx
6. joiner.int8.onnx
7. montage WORKERFS + vérification FS.stat
8. création OfflineRecognizer (sherpa / ONNX Runtime)
9. prêt

Le journal visible redirige aussi `Module.print` et `Module.printErr`, donc les messages natifs sherpa/ONNX émis par Emscripten apparaissent dans l'interface.

Pendant `new OfflineRecognizer(...)`, le Worker peut être entièrement occupé par un appel C++/WASM synchrone. Le chronomètre et l'âge du dernier signal sont calculés dans la page principale, donc ils continuent de bouger même dans ce cas.

Si une erreur subsiste, copier le journal visible depuis `PHASE recognizer-create` (ou la dernière phase atteinte) jusqu'à l'erreur, ainsi que les lignes de diagnostic par fichier.
