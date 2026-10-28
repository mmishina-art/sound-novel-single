#!/usr/bin/env python3
"""Sentence-level verification for Muse TTS draft: transcribe each muse-raw sentence MP3
with faster-whisper small, kana-convert both sides via pykakasi, compute similarity/len ratio.
Outputs work/verify-sentences-muse.json with flags for low-similarity sentences.
"""
import difflib, json, os, re, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel
import pykakasi
BASE=os.path.expanduser('~/workspace/sound-novel-single')
WORK=os.path.join(BASE,'work'); RAW=os.path.join(WORK,'muse-raw')
DATA=json.load(open(os.path.join(BASE,'data','chapters.json')))
plan=json.load(open(os.path.join(WORK,'sentences-muse.json')))
_kks=pykakasi.kakasi()
def norm(s): return re.sub(r'[、。！？『』「」・…―／\s,.!?%％"“”‘’\-]','',s)
def to_kana(s):
    hira=''.join(x['hira'] for x in _kks.convert(s))
    hira=''.join(chr(ord(c)-0x60) if 'ァ'<=c<='ヶ' else c for c in hira)
    return norm(hira)
model=WhisperModel('small',device='cpu',compute_type='int8')
def transcribe(path):
    raw=subprocess.run(['ffmpeg','-v','error','-i',path,'-f','f32le','-ar','16000','-ac','1','-'],capture_output=True).stdout
    segs,_=model.transcribe(np.frombuffer(raw,dtype=np.float32),language='ja')
    return ''.join(s.text for s in segs)
only=sys.argv[1:] or None
results={}
outpath=os.path.join(WORK,'verify-sentences-muse.json')
if os.path.exists(outpath): results=json.load(open(outpath))
for ch in DATA['chapters']:
    cid=ch['id']
    if only and cid not in only: continue
    results.setdefault(cid,{})
    for i,sent in enumerate(plan[cid]):
        if str(i) in results[cid] and 'kana_ratio' in results[cid][str(i)]:
            continue
        p=os.path.join(RAW,f'{cid}-{i}.mp3')
        heard=transcribe(p)
        tk,hk=to_kana(sent),to_kana(heard)
        ratio=difflib.SequenceMatcher(None,tk,hk).ratio() if tk and hk else 0
        lenr=len(hk)/max(len(tk),1)
        flag='OK' if (ratio>=0.80 and 0.70<=lenr<=1.35) else 'CHECK'
        results[cid][str(i)]={'target':sent,'heard':heard,'kana_ratio':round(ratio,3),'kana_lenratio':round(lenr,2),'flag':flag}
        if flag!='OK':
            print(f'{cid}-{i} CHECK sim={ratio:.2f} len={lenr:.2f}\n  T:{sent}\n  H:{heard}',flush=True)
    json.dump(results,open(outpath,'w'),ensure_ascii=False,indent=1)
    checks=[k for k,v in results[cid].items() if v['flag']!='OK']
    print(f'{cid} done, CHECK sentences: {checks}',flush=True)
print('saved',outpath)
