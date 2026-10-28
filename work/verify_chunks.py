#!/usr/bin/env python3
"""指定章のチャンクWAV（atempo前）を個別に文字起こしし、チャンク本文と突き合わせる。
崩壊・欠落チャンクの特定用。使い方: verify_chunks.py ch3 [ch5 ...]
"""
import difflib, json, os, re, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel
import pykakasi

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
RAW = os.path.join(WORK, 'raw')
PLAN = json.load(open(os.path.join(WORK, 'chunks.json')))
_kks = pykakasi.kakasi()

def norm(s):
    return re.sub(r'[、。！？『』「」・…―／\s,.!?%％"“”‘’\-]', '', s)

def to_kana(s):
    hira = ''.join(x['hira'] for x in _kks.convert(s))
    hira = ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in hira)
    return norm(hira)

model = WhisperModel('small', device='cpu', compute_type='int8')

def transcribe(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le',
                          '-ar', '16000', '-ac', '1', '-'], capture_output=True).stdout
    segs, _ = model.transcribe(np.frombuffer(raw, dtype=np.float32), language='ja')
    return ''.join(s.text for s in segs)

for cid in sys.argv[1:]:
    chunks = PLAN[cid]
    print(f'===== {cid}: {len(chunks)} chunks', flush=True)
    for i, text in enumerate(chunks):
        w = os.path.join(RAW, f'{cid}-{i}.wav')
        if not os.path.exists(w):
            print(f'  {cid}-{i}: MISSING WAV', flush=True)
            continue
        heard = transcribe(w)
        tk, hk = to_kana(text), to_kana(heard)
        kr = difflib.SequenceMatcher(None, tk, hk).ratio()
        kl = len(hk) / max(len(tk), 1)
        mark = '' if (kr >= 0.82 and 0.7 <= kl <= 1.35) else '  <-- CHECK'
        print(f'  {cid}-{i}: kana sim={kr:.2f} len={kl:.2f}{mark}', flush=True)
        if mark:
            print(f'    目標: {text}', flush=True)
            print(f'    聞取: {heard}', flush=True)
