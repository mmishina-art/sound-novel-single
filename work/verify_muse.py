#!/usr/bin/env python3
"""全7章の完成MP3を faster-whisper で文字起こしし、spoken と突き合わせる。
- 仕様どおり：spoken と文字起こしを正規化（句読点・空白除去）し difflib 類似度と長さ比を出す
- 併せて、spoken がかな主体のため pykakasi で双方をひらがな化した類似度も診断用に出す
  （漢字/かなの表記差は Whisper 側の同音異字として区別するための補助指標）
結果は work/verify-muse.json に保存。
"""
import difflib, json, os, re, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel
import pykakasi

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
AUDIO = os.path.join(BASE, 'audio')
DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
_kks = pykakasi.kakasi()

def clean_text(spoken):
    return ''.join([ln for ln in spoken.split('\n') if ln.strip() != '---'])

def norm(s):
    return re.sub(r'[、。！？『』「」・…―／\s,.!?%％"“”‘’\-]', '', s)

def to_kana(s):
    hira = ''.join(x['hira'] for x in _kks.convert(s))
    # 残ったカタカナをひらがなへ
    hira = ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in hira)
    return norm(hira)

model = WhisperModel('small', device='cpu', compute_type='int8')

def transcribe(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le',
                          '-ar', '16000', '-ac', '1', '-'], capture_output=True).stdout
    segs, _ = model.transcribe(np.frombuffer(raw, dtype=np.float32), language='ja')
    return ''.join(s.text for s in segs)

results = {}
only = sys.argv[1:] or None
for ch in DATA['chapters']:
    cid = ch['id']
    if only and cid not in only:
        continue
    mp3 = os.path.join(AUDIO, f'{cid}.mp3')
    if not os.path.exists(mp3):
        print(f'{cid}: MISSING MP3', flush=True)
        continue
    target = clean_text(ch['spoken'])
    heard = transcribe(mp3)
    t, h = norm(target), norm(heard)
    ratio = difflib.SequenceMatcher(None, t, h).ratio()
    lenratio = len(h) / max(len(t), 1)
    tk, hk = to_kana(target), to_kana(heard)
    kratio = difflib.SequenceMatcher(None, tk, hk).ratio()
    klenratio = len(hk) / max(len(tk), 1)
    flag = 'OK' if (ratio >= 0.82 and 0.75 <= lenratio <= 1.3) else 'CHECK'
    results[cid] = {'heard': heard, 'target': target,
                    'ratio': round(ratio, 3), 'lenratio': round(lenratio, 2),
                    'kana_ratio': round(kratio, 3), 'kana_lenratio': round(klenratio, 2),
                    'flag': flag}
    print(f'--- {cid} [{flag}] sim={ratio:.2f} len={lenratio:.2f} | kana sim={kratio:.2f} len={klenratio:.2f}', flush=True)
    print(f'  目標: {target}', flush=True)
    print(f'  聞取: {heard}', flush=True)

out = os.path.join(WORK, 'verify-muse.json')
if os.path.exists(out) and only:
    prev = json.load(open(out))
    prev.update(results)
    results = prev
json.dump(results, open(out, 'w'), ensure_ascii=False, indent=1)
print(f'== saved {out}')
