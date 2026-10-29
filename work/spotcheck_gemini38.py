#!/usr/bin/env python3
"""Spot-check flagged sentences: transcribe a wide window and print heard text."""
import json, subprocess, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util
spec = importlib.util.spec_from_file_location('v38', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'verify_gemini38_single.py'))
v = importlib.util.module_from_spec(spec); spec.loader.exec_module(v)
from faster_whisper import WhisperModel

def transcribe_range(model, mp3, start, end):
    import tempfile, subprocess
    fd, tmp = tempfile.mkstemp(suffix='.wav'); os.close(fd)
    cmd = ['ffmpeg', '-y', '-v', 'error']
    if start is not None: cmd += ['-ss', str(start)]
    if end is not None: cmd += ['-to', str(end)]
    cmd += ['-i', str(mp3), '-ar', '16000', '-ac', '1', '-f', 'f32le', tmp]
    subprocess.run(cmd, check=True)
    import numpy as np
    audio = np.fromfile(tmp, dtype=np.float32)
    os.unlink(tmp)
    segs, _ = model.transcribe(audio, language='ja', beam_size=1, vad_filter=True,
                               vad_parameters={'min_silence_duration_ms': 300})
    return ''.join(s.text for s in segs).replace(' ', '')

from pathlib import Path
ROOT = Path(v.BASE)
verify = json.load(open(ROOT / 'work/verify-gemini38.json'))
utimes = json.load(open(ROOT / 'work/gemini38/unitTimes.json'))
model = WhisperModel('small', device='cpu', compute_type='int8')

CASES = [
    ('ch2', 46), ('ch3', 29), ('ch4', 37), ('ch5', 15), ('ch6', 25), ('ch6', 29),
]
for ch, idx in CASES:
    d = verify[ch]
    starts = utimes[ch]
    s0 = max(0.0, starts[idx] - 5.0)
    end = starts[idx + 1] if idx + 1 < len(starts) else None
    e0 = (end + 5.0) if end else None
    heard = transcribe_range(model, ROOT / f'work/gemini38/audio/{ch}.mp3', s0, e0)
    tgt = d['results'][idx]['target']
    print(f'{ch} #{idx} target: {tgt}')
    print(f'   window heard: {heard}')
    print()

# ch5 title call re-check
t = transcribe_range(model, ROOT / 'work/gemini38/audio/ch5-title.mp3', None, None)
print('ch5-title heard:', t)
print('ch5-title target:', verify['ch5']['title_target'])
