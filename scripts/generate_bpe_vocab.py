#!/usr/bin/env python3
"""Generate bpe.vocab for NVIDIA Parakeet v2 from its NeMo checkpoint.
Uses only Python stdlib + sentencepiece. Intended for CI, not end-user PCs.
"""
from __future__ import annotations
import argparse, pathlib, shutil, tarfile, tempfile
import sentencepiece as spm

p=argparse.ArgumentParser();p.add_argument('nemo');p.add_argument('output');args=p.parse_args()
nemo=pathlib.Path(args.nemo);out=pathlib.Path(args.output);out.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory() as td:
    tok=pathlib.Path(td)/'tokenizer.model'
    with tarfile.open(nemo,'r:*') as tf:
        matches=[m for m in tf.getmembers() if m.isfile() and m.name.endswith('tokenizer.model')]
        if not matches: raise SystemExit('tokenizer.model introuvable dans le checkpoint .nemo')
        f=tf.extractfile(matches[0]);
        if f is None: raise SystemExit('Impossible de lire tokenizer.model')
        with tok.open('wb') as dst: shutil.copyfileobj(f,dst)
    sp=spm.SentencePieceProcessor(model_file=str(tok))
    with out.open('w',encoding='utf-8',newline='\n') as f:
        for i in range(sp.get_piece_size()):
            f.write(f"{sp.id_to_piece(i)}\t{sp.get_score(i)}\n")
print(f'Generated {out} ({out.stat().st_size} bytes, {sp.get_piece_size()} pieces)')
