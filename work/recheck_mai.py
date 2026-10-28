#!/usr/bin/env python3
"""文単位検証（small）で CHECK になった文を Whisper medium で再照合し、
ASR 側の聞き違い・表記ゆれかどうかを切り分ける。"""
import json, os, re, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
SEG = os.path.join(WORK, 'mai-stretched')
res = json.load(open(os.path.join(WORK, 'verify-mai.json')))
flags = []
for cid in ('ch2', 'ch4', 'ch6'):
    for i, v in res.get(cid, {}).items():
        if v['flag'] != 'OK':
            flags.append((cid, int(i), v['target'], v['heard']))
print(f'flagged: {len(flags)}', flush=True)
model = WhisperModel('medium', device='cpu', compute_type='int8')
for cid, i, target, heard_small in flags:
    p = os.path.join(SEG, f'{cid}-{i}.mp3')
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', p, '-f', 'f32le', '-ar', '16000', '-ac', '1', '-'],
                         capture_output=True).stdout
    segs, _ = model.transcribe(np.frombuffer(raw, dtype=np.float32), language='ja')
    heard = ''.join(s.text for s in segs)
    print(f'{cid}-{i}\n  T: {target}\n  small : {heard_small}\n  medium: {heard}', flush=True)
print('RECHECK DONE', flush=True)
