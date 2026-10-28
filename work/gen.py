#!/usr/bin/env python3
"""『空の郵便が届くまで』全7章の朗読音声を Gemini TTS で生成する。

- 章ごとに narrator で声を切替（female=Leda / male=Charon）、スタイル指示はテキスト先頭に埋め込む
- spoken を文（。！？）単位で区切り、1チャンク100〜200字程度にまとめる（文の途中で切らない）
- API呼び出し後は最低25秒スリープ。429等の失敗時は 60→120秒…と間隔を広げて再試行（最大6回）
- チャンクWAVは work/raw/ch{N}-{i}.wav に保存し、既存はスキップ（再開可能）
- 進捗・統計は work/stats.json に都度保存
- 章の組み立て：24kHz mono 正規化 → 0.3秒無音を挟んで結合 → 目標300字/分に atempo のみで調整 → audio/ch{N}.mp3 (96kbps)
"""
import json, os, re, subprocess, sys, time

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
RAW = os.path.join(WORK, 'raw')
AUDIO = os.path.join(BASE, 'audio')
os.makedirs(RAW, exist_ok=True)
os.makedirs(AUDIO, exist_ok=True)
HELPER = os.path.expanduser('~/workspace/custom-connectors/custom.google-gemini-api/bin/gemini_tts.py')

STYLE_F = '小説の朗読です。透明感のある、儚げで柔らかい声で読んでください。澄んだ静けさを保ち、囁かずに自然な声量で、穏やかに読んでください:\n'
STYLE_M = '小説の朗読です。やわらかく穏やかな男性の声で読んでください。強さや格好よさは抑えて、親しみやすく、静かに寄り添うような語り口で読んでください:\n'
VOICE = {'female': ('Leda', STYLE_F), 'male': ('Charon', STYLE_M)}

DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
STATS_PATH = os.path.join(WORK, 'stats.json')
stats = json.load(open(STATS_PATH)) if os.path.exists(STATS_PATH) else {
    'api_calls': 0, 'api_failures': 0, 'chapters': {}}
stats.setdefault('api_calls', 0)
stats.setdefault('api_failures', 0)
stats.setdefault('chapters', {})

def save_stats():
    json.dump(stats, open(STATS_PATH, 'w'), ensure_ascii=False, indent=1)

def clean_text(spoken):
    lines = [ln for ln in spoken.split('\n') if ln.strip() != '---']
    return ''.join(lines)

def split_sentences(text):
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]

def make_chunks(text):
    sents = split_sentences(text)
    chunks, cur = [], ''
    for s in sents:
        if not cur:
            cur = s
        elif len(cur) + len(s) <= 200:
            cur += s
        else:
            chunks.append(cur)
            cur = s
    if cur:
        chunks.append(cur)
    # 末尾チャンクが短すぎる場合、前チャンク末尾の文を移して均す
    while len(chunks) >= 2 and len(chunks[-1]) < 100:
        prev_sents = split_sentences(chunks[-2])
        if len(prev_sents) < 2:
            break
        move = prev_sents[-1]
        if len(chunks[-2]) - len(move) < 100:
            break
        chunks[-2] = ''.join(prev_sents[:-1])
        chunks[-1] = move + chunks[-1]
    return chunks

# チャンク計画を保存（検証時のチャンク特定にも使う）
plan = {}
for ch in DATA['chapters']:
    plan[ch['id']] = make_chunks(clean_text(ch['spoken']))
json.dump(plan, open(os.path.join(WORK, 'chunks.json'), 'w'), ensure_ascii=False, indent=1)

def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return float(r.stdout.strip())

def atempo_chain(factor):
    filters, f = [], factor
    while f > 100:
        filters.append('atempo=100'); f /= 100
    while f < 0.5:
        filters.append('atempo=0.5'); f /= 0.5
    filters.append(f'atempo={f:.4f}')
    return ','.join(filters)

def synth(text_file, voice, out_wav):
    """1回試行。成功で True"""
    stats['api_calls'] += 1
    save_stats()
    r = subprocess.run(['python3', HELPER, text_file, voice, out_wav],
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        stats['api_failures'] += 1
        save_stats()
        print('  API fail:', (r.stderr or r.stdout)[-300:], flush=True)
        return False
    return True

def build_chapter(ch, chunks):
    cid = ch['id']
    spoken_chars = ch['spokenChars']
    norm = []
    for i in range(len(chunks)):
        w = os.path.join(RAW, f'{cid}-{i}.wav')
        n = os.path.join(RAW, f'{cid}-{i}-n.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', w, '-ar', '24000', '-ac', '1', n], check=True)
        norm.append(n)
    gap = os.path.join(RAW, 'gap.wav')
    if not os.path.exists(gap):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'anullsrc=r=24000:cl=mono', '-t', '0.3', gap], check=True)
    lst = os.path.join(RAW, f'{cid}-list.txt')
    with open(lst, 'w') as fh:
        for j, n in enumerate(norm):
            if j:
                fh.write(f"file '{gap}'\n")
            fh.write(f"file '{n}'\n")
    joined = os.path.join(RAW, f'{cid}-joined.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, joined], check=True)
    dur_raw = duration(joined)
    target = spoken_chars / 300 * 60
    out_mp3 = os.path.join(AUDIO, f'{cid}.mp3')
    # CPM 298〜305 に収まるまで atempo を再計算して調整（最大3回）
    factor = dur_raw / target
    for _ in range(3):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', joined, '-af', atempo_chain(factor),
                        '-b:a', '96k', out_mp3], check=True)
        dur_final = duration(out_mp3)
        cpm = spoken_chars / (dur_final / 60)
        if 298 <= cpm <= 305:
            break
        factor = factor * (dur_final / target)
    info = {'done': True, 'chunks': len(chunks), 'spokenChars': spoken_chars,
            'raw_sec': round(dur_raw, 2), 'atempo': round(factor, 4),
            'final_sec': round(dur_final, 2), 'cpm': round(cpm, 1)}
    stats['chapters'][cid] = {**stats['chapters'].get(cid, {}), **info}
    save_stats()
    print(f'   {cid}: raw {dur_raw:.1f}s -> atempo {factor:.3f} -> {dur_final:.1f}s (CPM {cpm:.1f})', flush=True)
    return info

only = sys.argv[1:] or None
for ch in DATA['chapters']:
    cid = ch['id']
    if only and cid not in only:
        continue
    voice, style = VOICE[ch['narrator']]
    chunks = plan[cid]
    cstat = stats['chapters'].setdefault(cid, {'chunks_total': len(chunks), 'chunks_done': 0})
    print(f'== {cid} ({ch["narrator"]}/{voice}): {ch["spokenChars"]} chars, {len(chunks)} chunks', flush=True)
    ok = True
    for i, chunk in enumerate(chunks):
        w = os.path.join(RAW, f'{cid}-{i}.wav')
        if os.path.exists(w) and os.path.getsize(w) > 1000:
            continue
        tf = os.path.join(RAW, f'{cid}-{i}.txt')
        open(tf, 'w').write(style + chunk)
        done = False
        waits = [0, 60, 120, 180, 240, 300]  # 初回 + 再試行5回 = 最大6回試行
        for attempt, wait in enumerate(waits):
            if wait:
                print(f'  retry {attempt} for {cid}-{i} after {wait}s', flush=True)
                time.sleep(wait)
            if synth(tf, voice, w):
                done = True
                break
        if not done:
            print(f'  !! {cid}-{i} gave up after {len(waits)} attempts', flush=True)
            ok = False
            break
        cstat['chunks_done'] = sum(
            1 for j in range(len(chunks))
            if os.path.exists(os.path.join(RAW, f'{cid}-{j}.wav')))
        save_stats()
        print(f'  {cid}-{i} done ({len(chunk)} chars), sleep 25s', flush=True)
        time.sleep(25)
    if not ok:
        save_stats()
        continue
    build_chapter(ch, chunks)

stats['finished_at'] = time.time()
save_stats()
done = sum(1 for v in stats['chapters'].values() if v.get('done'))
print(f'ALL DONE: {done}/{len(DATA["chapters"])} chapters, api_calls={stats["api_calls"]}, failures={stats["api_failures"]}', flush=True)
