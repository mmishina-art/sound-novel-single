#!/usr/bin/env python3
"""男性パート声差し替え：Muse TTS avocado_v2:MAI_03 (ja_JP)
- 対象：男性章 ch2, ch4, ch6 の全声（女性章 Lily は変更しない）
- 理由：素のG（qvd_02415）はところどころ英語訛りの日本語になるため不可（ユーザー評価）
- 設定：speed 90（「優しく落ち着いた感じ」寄せ。100では実測453字/分と速すぎ、
  90で実測約393字/分）。ピッチ・EQ 等の後処理は一切しない。
- テンポ：完成音声の実測で分速300字に合わせる。章ごとに
  「必要発話時間 = 総字数/300*60 − 文間無音(0.3s×(n-1))」を求め、
  atempo = 実測発話時間 / 必要発話時間 を文ごとに適用してから結合する
  （無音は0.3sのまま保つ）。
- 生成は文単位（読み上げ文は chapters.json の spoken ＝かな固定そのまま）。
- 出力：audio/ch{N}.mp3 と public/book/audio/ch{N}.mp3（24kHz mono 96kbps）
"""
import json, os, re, subprocess, sys, time, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
RAW = os.path.join(WORK, 'mai-raw')
STRETCHED = os.path.join(WORK, 'mai-stretched')
AUDIO = os.path.join(BASE, 'audio')
APP_AUDIO = os.path.join(BASE, 'public', 'book', 'audio')
os.makedirs(RAW, exist_ok=True)
os.makedirs(STRETCHED, exist_ok=True)
TTS = '/opt/hatch/bin/tts'
VOICE = 'avocado_v2:MAI_03'
SPEED = 90
TARGET_CPM = 300.0
GAP_SEC = 0.3
MALE = ['ch2', 'ch4', 'ch6']
DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
STATS_PATH = os.path.join(WORK, 'stats-mai.json')
lock = threading.Lock()
stats = json.load(open(STATS_PATH)) if os.path.exists(STATS_PATH) else {'tts_calls': 0, 'tts_failures': 0, 'chapters': {}}
stats.setdefault('tts_calls', 0)
stats.setdefault('tts_failures', 0)
stats.setdefault('chapters', {})


def save_stats():
    with lock:
        json.dump(stats, open(STATS_PATH, 'w'), ensure_ascii=False, indent=1)


def clean_text(spoken):
    return ''.join([ln for ln in spoken.split('\n') if ln.strip() != '---'])


def split_sentences(text):
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]


plan = {}
for ch in DATA['chapters']:
    if ch['id'] in MALE:
        plan[ch['id']] = split_sentences(clean_text(ch['spoken']))


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                       capture_output=True, text=True)
    return float(r.stdout.strip())


def synth_one(args):
    cid, i, sent = args
    out = os.path.join(RAW, f'{cid}-{i}.mp3')
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        return (cid, i, True, True)
    waits = [0, 5, 15, 30, 60]
    for attempt, wait in enumerate(waits):
        if wait:
            time.sleep(wait)
        with lock:
            stats['tts_calls'] += 1
        save_stats()
        try:
            r = subprocess.run([TTS, 'speak', '--output', out, '--voice', VOICE, '--language', 'ja_JP',
                                '--speed', str(SPEED), '--text-stdin'],
                               input=sent.encode(), capture_output=True, timeout=180)
            if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 1000:
                return (cid, i, True, False)
        except Exception as e:
            print(f'  exc {cid}-{i}: {e}', flush=True)
        with lock:
            stats['tts_failures'] += 1
        save_stats()
        try:
            if os.path.exists(out) and os.path.getsize(out) <= 1000:
                os.remove(out)
        except Exception:
            pass
    return (cid, i, False, False)


def build_chapter(cid):
    sents = plan[cid]
    total_chars = sum(len(s) for s in sents)
    raw_durs = [duration(os.path.join(RAW, f'{cid}-{j}.mp3')) for j in range(len(sents))]
    speech = sum(raw_durs)
    required_speech = total_chars / TARGET_CPM * 60 - GAP_SEC * (len(sents) - 1)
    atempo = speech / required_speech
    print(f'  {cid}: chars={total_chars} raw_speech={speech:.1f}s required={required_speech:.1f}s '
          f'atempo={atempo:.4f} raw_cpm={total_chars / speech * 60:.1f}', flush=True)
    # 文ごとに atempo を適用したセグメントを作る（無音は別途 0.3s を差し込む）
    seg_paths = []
    for j in range(len(sents)):
        seg = os.path.join(STRETCHED, f'{cid}-{j}.mp3')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(RAW, f'{cid}-{j}.mp3'),
                        '-af', f'atempo={atempo:.5f}', '-ar', '24000', '-ac', '1', '-b:a', '96k', seg], check=True)
        seg_paths.append(seg)
    gap = os.path.join(STRETCHED, 'gap.mp3')
    if not os.path.exists(gap):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
                        '-t', str(GAP_SEC), '-b:a', '96k', gap], check=True)
    lst = os.path.join(STRETCHED, f'{cid}-list.txt')
    with open(lst, 'w') as fh:
        for j, seg in enumerate(seg_paths):
            if j:
                fh.write(f"file '{gap}'\n")
            fh.write(f"file '{seg}'\n")
    out_mp3 = os.path.join(AUDIO, f'{cid}.mp3')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
                    '-ar', '24000', '-ac', '1', '-b:a', '96k', out_mp3], check=True)
    subprocess.run(['cp', out_mp3, os.path.join(APP_AUDIO, f'{cid}.mp3')], check=True)
    dur = duration(out_mp3)
    cpm = total_chars / dur * 60
    stats['chapters'][cid] = {'sentences': len(sents), 'chars': total_chars, 'voice': VOICE, 'speed': SPEED,
                              'atempo': round(atempo, 4), 'raw_speech_sec': round(speech, 2),
                              'final_sec': round(dur, 2), 'final_cpm': round(cpm, 1), 'done': True}
    save_stats()
    print(f'  built {cid}: {dur:.1f}s -> {cpm:.1f} chars/min', flush=True)


only = [a for a in sys.argv[1:] if a in MALE] or MALE
tasks = []
for cid in only:
    for i, sent in enumerate(plan[cid]):
        tasks.append((cid, i, sent))
print(f'total sentences: {len(tasks)}', flush=True)
failed = []
done_count = 0
skipped = 0
with ThreadPoolExecutor(max_workers=4) as ex:
    futs = {ex.submit(synth_one, t): t for t in tasks}
    for fut in as_completed(futs):
        cid, i, ok, was_skip = fut.result()
        if was_skip:
            skipped += 1
        if ok:
            done_count += 1
        else:
            failed.append((cid, i))
            print(f'FAILED {cid}-{i}', flush=True)
        if (done_count + len(failed)) % 40 == 0:
            print(f'progress {done_count + len(failed)}/{len(tasks)} ok={done_count} skipped={skipped} '
                  f'failed={len(failed)} calls={stats["tts_calls"]} failures={stats["tts_failures"]}', flush=True)
print(f'generation done ok={done_count} skipped={skipped} failed={failed} calls={stats["tts_calls"]} failures={stats["tts_failures"]}', flush=True)
if failed:
    save_stats()
    sys.exit(2)
for cid in only:
    build_chapter(cid)
stats['finished_at'] = time.time()
save_stats()
print('ALL BUILT', flush=True)
