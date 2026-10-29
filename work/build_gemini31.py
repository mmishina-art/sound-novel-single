#!/usr/bin/env python3
"""制作ボイス版（Gemini 3.1）の組み立て：文WAV → atempo → 結合 → 章MP3。

- 材料：work/gemini31-raw/ch{N}-{j}.wav（gen_gemini31.py の生成物）
- 確定レシピ：文ごとに atempo（女性 ×1.20／男性 ×1.30、音質加工は atempo のみ）を
  適用したセグメントを、つなぎ目 0.1 秒の無音で結合する
- atempo 後のセグメントは work/gemini31-stretched/ch{N}-{j}.wav に残し、
  build_timings.py（--gap 0.1 --female-dir/--male-dir ともに gemini31-stretched）が
  unitTimes を実測再構成できるようにする
- 章題コール：3文の頭尻の無音を詰め（頭0.12秒・尻0.10秒残し）、同じ atempo を
  かけて 0.3 秒間隔で結合する
- 出力はステージング audio/gemini31/ch{N}.mp3 と ch{N}-title.mp3。
  公開側（public/book/audio）への差し替えは全章が揃ってから別途行う
  （同じ本の中で声の世代を混ぜないため）
- 音量の統一：モデルの出力は文・章ごとに音量がばらつくため、結合後の WAV を
  loudnorm（2パス実測）で全章・章題コール共通の目標 −25 LUFS / TP −1.5dB に
  正規化してから MP3 化する（現行公開版の朗読水準 ≒ −25 LUFS に合わせた）
"""
import json, os, re, subprocess, sys


def measure_loudnorm(path):
    """loudnorm の1パス目：実測値を JSON で返す（取れなければ None）"""
    r = subprocess.run(['ffmpeg', '-hide_banner', '-i', path,
                        '-af', f'loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json',
                        '-f', 'null', '-'], capture_output=True, text=True)
    m = re.search(r'\{\s*"input_i".*?\}', r.stderr, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def normalize_wav(src, dst):
    """結合後 WAV を目標ラウドネスへ正規化する（2パス実測、線形優先）。
    実測が取れない場合は loudnorm の1パス処理にフォールバックする。"""
    meas = measure_loudnorm(src)
    if meas:
        af = (f'loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA={TARGET_LRA}'
              f':measured_I={meas["input_i"]}:measured_TP={meas["input_tp"]}'
              f':measured_LRA={meas["input_lra"]}:measured_thresh={meas["input_thresh"]}'
              f':offset={meas["target_offset"]}:linear=true')
    else:
        af = f'loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA={TARGET_LRA}'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', af,
                    '-ar', '24000', '-ac', '1', dst], check=True)

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
RAW = os.path.join(WORK, 'gemini31-raw')
STRETCHED = os.path.join(WORK, 'gemini31-stretched')
OUT = os.path.join(BASE, 'audio', 'gemini31')
os.makedirs(STRETCHED, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

ATEMPO = {'female': 1.20, 'male': 1.30}
GAP_SEC = 0.1
TITLE_GAP_SEC = 0.3
TARGET_I = -25.0    # LUFS（全章・コール共通の音量目標）
TARGET_TP = -1.5    # dBTP
TARGET_LRA = 11.0
DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return float(r.stdout.strip())


def gen_split(text):
    text = ''.join(ln for ln in text.split('\n') if ln.strip() != '---')
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]


def join_mp3(parts, gap_sec, out_mp3, work_prefix):
    gap = os.path.join(STRETCHED, 'gap.wav')
    if not os.path.exists(gap):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                        'anullsrc=r=24000:cl=mono', '-t', '1', gap], check=True)
    lst = os.path.join(STRETCHED, f'{work_prefix}-list.txt')
    with open(lst, 'w') as fh:
        for j, p in enumerate(parts):
            if j:
                fh.write(f"file '{gap}'\n")
            fh.write(f"file '{p}'\n")
    # gap.wav は1秒あるので、結合時に各パートの間へ gap_sec だけ差し込むため
    # 無音ファイルを必要な長さに切り直して使う
    gap_f = os.path.join(STRETCHED, f'gap-{gap_sec}.wav')
    if not os.path.exists(gap_f):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', gap,
                        '-t', str(gap_sec), gap_f], check=True)
    with open(lst, 'w') as fh:
        for j, p in enumerate(parts):
            if j:
                fh.write(f"file '{gap_f}'\n")
            fh.write(f"file '{p}'\n")
    joined = os.path.join(STRETCHED, f'{work_prefix}-joined.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0',
                    '-i', lst, '-ar', '24000', '-ac', '1', joined], check=True)
    normed = os.path.join(STRETCHED, f'{work_prefix}-norm.wav')
    normalize_wav(joined, normed)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', normed,
                    '-b:a', '96k', out_mp3], check=True)
    return duration(out_mp3)


def trim_silence(src, dst):
    """頭尻の無音を詰める（頭0.12秒・尻0.10秒残し）。gen_title_calls.py と同じ流儀"""
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', src, '-af',
                        'silencedetect=noise=-45dB:d=0.1', '-f', 'null', '-'],
                       capture_output=True, text=True)
    dur = duration(src)
    head_end, tail_start = 0.0, dur
    pairs, pending = [], None
    for line in r.stderr.splitlines():
        if 'silence_start:' in line:
            pending = float(line.split('silence_start:')[1].strip())
        elif 'silence_end:' in line and pending is not None:
            pairs.append((pending, float(line.split('silence_end:')[1].split('|')[0].strip())))
            pending = None
    if pairs and pairs[0][0] <= 0.01:
        head_end = pairs[0][1]
    if pairs and abs(pairs[-1][1] - dur) <= 0.05:
        tail_start = pairs[-1][0]
    start = max(0.0, head_end - 0.12)
    end = min(dur, tail_start + 0.10)
    if end - start < 0.3:
        subprocess.run(['cp', src, dst], check=True)
        return
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', src,
                    '-af', f'atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS',
                    '-ar', '24000', '-ac', '1', dst], check=True)


def build_chapter(ch):
    cid = ch['id']
    n = cid[2:]
    factor = ATEMPO[ch['narrator']]
    sents = gen_split(ch['spoken'])
    raws = [os.path.join(RAW, f'{cid}-{j}.wav') for j in range(len(sents))]
    if not all(os.path.exists(w) for w in raws):
        missing = [j for j, w in enumerate(raws) if not os.path.exists(w)]
        print(f'{cid}: SKIP (missing sentences {missing})')
        return False
    stretched = []
    for j, w in enumerate(raws):
        s = os.path.join(STRETCHED, f'{cid}-{j}.wav')
        if not os.path.exists(s):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', w,
                            '-af', f'atempo={factor}', '-ar', '24000', '-ac', '1', s],
                           check=True)
        stretched.append(s)
    out = os.path.join(OUT, f'ch{n}.mp3')
    dur = join_mp3(stretched, GAP_SEC, out, cid)
    chars = ch['spokenChars']
    print(f'{cid}: {len(sents)} sentences, atempo {factor} -> {dur:.1f}s '
          f'({chars / (dur / 60):.0f} chars/min) -> {out}')
    # 章題コール
    t_raws = [os.path.join(RAW, f'{cid}-title-{k}.wav') for k in range(3)]
    if all(os.path.exists(w) for w in t_raws):
        t_parts = []
        for k, w in enumerate(t_raws):
            t = os.path.join(STRETCHED, f'{cid}-title-{k}.wav')
            if not os.path.exists(t):
                trimmed = os.path.join(STRETCHED, f'{cid}-title-{k}-trim.wav')
                trim_silence(w, trimmed)
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', trimmed,
                                '-af', f'atempo={factor}', '-ar', '24000', '-ac', '1', t],
                               check=True)
            t_parts.append(t)
        t_out = os.path.join(OUT, f'ch{n}-title.mp3')
        t_dur = join_mp3(t_parts, TITLE_GAP_SEC, t_out, f'{cid}-title')
        print(f'{cid}-title: -> {t_dur:.1f}s -> {t_out}')
    else:
        print(f'{cid}-title: SKIP (title sentences not ready)')
    return True


def main():
    only = sys.argv[1:] or None
    for ch in DATA['chapters']:
        if only and ch['id'] not in only:
            continue
        build_chapter(ch)


if __name__ == '__main__':
    main()
