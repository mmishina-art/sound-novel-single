#!/usr/bin/env python3
"""章題コールの文字起こし検証：生成した ch{N}-title.mp3 を faster-whisper で起こし、
意図した読み上げ文と（句読点を除いて）一致するか確認する。
使い方: ~/workspace/.asr-venv/bin/python work/verify_title_calls.py
"""
import json, os, re, subprocess, sys

BASE = os.path.expanduser('~/workspace/sound-novel-single')
sys.path.insert(0, os.path.join(BASE, 'work'))
from gen_title_calls import CALLS  # noqa: E402

from faster_whisper import WhisperModel  # noqa: E402


def norm(s):
    return re.sub(r'[。、・「」\s]', '', s)


def main():
    model = WhisperModel('small')
    ok = True
    for cid, _narrator, segments in CALLS:
        text = ''.join(segments)
        path = os.path.join(BASE, 'public', 'book', 'audio', f'ch{cid[2:]}-title.mp3')
        raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ar', '16000', '-ac', '1', '-'],
                             capture_output=True).stdout
        import numpy as np
        audio = np.frombuffer(raw, dtype=np.float32)
        segs, _info = model.transcribe(audio, language='ja')
        heard = ''.join(s.text for s in segs)
        match = norm(heard) == norm(text)
        ok = ok and match
        print(f'{cid}: {"OK " if match else "NG "} intended={text!r}')
        print(f'      heard  ={heard!r}')
    print('ALL OK' if ok else 'MISMATCH FOUND')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
