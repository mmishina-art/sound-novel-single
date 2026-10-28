#!/usr/bin/env python3
"""Muse built-in TTS draft version for 『空の郵便が届くまで』
- Female (ch1,3,5,7): avocado_v2:Lily speed 112, no post-processing
- Male (ch2,4,6): avocado_v2:qvd_02415 speed 104, PLAIN G, NO post-processing
  (spec change 2026-10-28: g-mod3a rubberband/EQ/highshelf NOT applied)
- Sentence-by-sentence generation, skip existing, concurrency 4, up to 5 attempts
- Assemble: 0.3s silence between sentences, 96kbps MP3 to audio/ch{N}.mp3 and public/book/audio/ch{N}.mp3
- No atempo / tempo adjustment
"""
import json, os, re, subprocess, sys, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
RAW = os.path.join(WORK, 'muse-raw')
AUDIO = os.path.join(BASE, 'audio')
APP_AUDIO = os.path.join(BASE, 'public', 'book', 'audio')
os.makedirs(RAW, exist_ok=True); os.makedirs(AUDIO, exist_ok=True); os.makedirs(APP_AUDIO, exist_ok=True)
TTS = '/opt/hatch/bin/tts'
VOICE = {
 'female': ('avocado_v2:Lily', 112),
 'male': ('avocado_v2:qvd_02415', 104),  # plain, no effects
}
DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
STATS_PATH = os.path.join(WORK, 'stats-muse.json')
lock = threading.Lock()
stats = json.load(open(STATS_PATH)) if os.path.exists(STATS_PATH) else {'tts_calls':0,'tts_failures':0,'chapters':{},'regen':[]}
stats.setdefault('tts_calls',0); stats.setdefault('tts_failures',0); stats.setdefault('chapters',{}); stats.setdefault('regen',[])

def save_stats():
    with lock:
        json.dump(stats, open(STATS_PATH,'w'), ensure_ascii=False, indent=1)

def clean_text(spoken):
    return ''.join([ln for ln in spoken.split('\n') if ln.strip()!='---'])
def split_sentences(text):
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]

plan={}
for ch in DATA['chapters']:
    plan[ch['id']]=split_sentences(clean_text(ch['spoken']))
json.dump(plan, open(os.path.join(WORK,'sentences-muse.json'),'w'), ensure_ascii=False, indent=1)

def synth_one(args):
    ch, i, sent = args
    cid=ch['id']
    out=os.path.join(RAW, f'{cid}-{i}.mp3')
    if os.path.exists(out) and os.path.getsize(out)>1000:
        return (cid,i,True,True)
    voice,speed=VOICE[ch['narrator']]
    waits=[0,5,15,30,60]
    for attempt,wait in enumerate(waits):
        if wait: time.sleep(wait)
        with lock:
            stats['tts_calls']+=1
        save_stats()
        try:
            r=subprocess.run([TTS,'speak','--output',out,'--voice',voice,'--language','ja_JP','--speed',str(speed),'--text-stdin'],
                             input=sent.encode(), capture_output=True, timeout=180)
            if r.returncode==0 and os.path.exists(out) and os.path.getsize(out)>1000:
                return (cid,i,True,False)
        except Exception as e:
            print(f'  exc {cid}-{i}: {e}', flush=True)
        with lock:
            stats['tts_failures']+=1
        save_stats()
        # remove partial
        try:
            if os.path.exists(out) and os.path.getsize(out)<=1000: os.remove(out)
        except: pass
    return (cid,i,False,False)

def duration(path):
    r=subprocess.run(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',path],capture_output=True,text=True)
    return float(r.stdout.strip())

def build_chapter(ch):
    cid=ch['id']; sents=plan[cid]
    # normalize each to wav 24k mono for clean concat? Use mp3 concat via list with re-encode at end.
    gap=os.path.join(RAW,'gap.mp3')
    if not os.path.exists(gap):
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','anullsrc=r=24000:cl=mono','-t','0.3','-b:a','96k',gap],check=True)
    lst=os.path.join(RAW,f'{cid}-list.txt')
    with open(lst,'w') as fh:
        for j in range(len(sents)):
            if j: fh.write(f"file '{gap}'\n")
            fh.write(f"file '{os.path.join(RAW, f'{cid}-{j}.mp3')}'\n")
    out_mp3=os.path.join(AUDIO,f'{cid}.mp3')
    subprocess.run(['ffmpeg','-v','error','-y','-f','concat','-safe','0','-i',lst,'-ar','24000','-ac','1','-b:a','96k',out_mp3],check=True)
    # NO post-processing for male either (plain G spec)
    app_mp3=os.path.join(APP_AUDIO,f'{cid}.mp3')
    subprocess.run(['cp',out_mp3,app_mp3],check=True)
    dur=duration(out_mp3)
    stats['chapters'][cid]={'sentences':len(sents),'narrator':ch['narrator'],'voice':VOICE[ch['narrator']][0],'speed':VOICE[ch['narrator']][1],'post_processing':'none','final_sec':round(dur,2),'done':True}
    save_stats()
    print(f'  built {cid}: {dur:.1f}s', flush=True)
    return dur

only=sys.argv[1:] or None
tasks=[]
for ch in DATA['chapters']:
    if only and ch['id'] not in only: continue
    for i,sent in enumerate(plan[ch['id']]):
        tasks.append((ch,i,sent))
print(f'total sentences to check: {len(tasks)}', flush=True)
failed=[]
done_count=0; skipped=0
with ThreadPoolExecutor(max_workers=4) as ex:
    futs={ex.submit(synth_one,t):t for t in tasks}
    for fut in as_completed(futs):
        cid,i,ok,was_skip=fut.result()
        if was_skip: skipped+=1
        if ok: done_count+=1
        else:
            failed.append((cid,i))
            print(f'FAILED {cid}-{i}', flush=True)
        if (done_count+len(failed))%50==0:
            print(f'progress {done_count+len(failed)}/{len(tasks)} ok={done_count} skipped={skipped} failed={len(failed)} calls={stats["tts_calls"]} failures={stats["tts_failures"]}', flush=True)
print(f'generation done ok={done_count} skipped={skipped} failed={failed} calls={stats["tts_calls"]} failures={stats["tts_failures"]}', flush=True)
if failed:
    save_stats(); sys.exit(2)
for ch in DATA['chapters']:
    if only and ch['id'] not in only: continue
    build_chapter(ch)
stats['finished_at']=time.time()
save_stats()
print('ALL BUILT', flush=True)
