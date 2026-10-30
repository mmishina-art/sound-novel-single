#!/usr/bin/env python3
"""制作ボイス版（Gemini 3.8 Flash）の組み立て：長文WAV → テンポ補正 → 音量正規化 → 章MP3。

- 材料：work/gemini38/raw/ch{N}.wav / ch{N}-title.wav（gen_gemini38_single.py の生成物）
- テンポ：完成音声の実測で 300 字/分を標準に、章単位で atempo 補正する
  （字数 = spoken の生成側分割の連結長。build_gemini31.py と同じ物差し）
- 音量：全章・章題コール共通で loudnorm（2パス実測）−25 LUFS / TP −1.5dB に
  正規化する（単行本の既存制作基準＝現行公開版の朗読水準に合わせた値）
- 章題コールは頭尻の無音を詰め（頭0.12秒・尻0.15秒残し）、同じく 300字/分へ
  寄せてから正規化する（倍率は 0.85〜1.45 にクランプ）
- 出力はステージング work/gemini38/audio/ch{N}.mp3 と ch{N}-title.mp3。
  アプリ側（public/book/）への差し替えは別作業で行う（この段階では触らない）
- 最終エンコードは 24kHz モノラル 64kbps（v1.13.0 で 96k から変更。朗読は声
  だけなのでモノラルで十分で、配信総量が約1/3減る。正規化済み WAV から
  1回だけエンコードすること。MP3 からの再エンコードは音量が約0.4 LU 下がる）
"""
import json, os, re, subprocess, sys

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
STAGE = os.path.join(WORK, 'gemini38')
RAW = os.path.join(STAGE, 'raw')
PROC = os.path.join(STAGE, 'proc')
OUT = os.path.join(STAGE, 'audio')
os.makedirs(PROC, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

TARGET_CPM = 300.0
TARGET_I = -25.0    # LUFS（単行本の既存制作基準）
TARGET_TP = -1.5    # dBTP
TARGET_LRA = 11.0
DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
CALLS = {
    'ch1': 'だいいっしょう。雨の日の客。語り、かしわぎはるか。',
    'ch2': 'だいにしょう。忘れ物の傘。語り、にしのゆうま。',
    'ch3': 'だいさんしょう。とりおきの本。語り、かしわぎはるか。',
    'ch4': 'だいよんしょう。感想の宿題。語り、にしのゆうま。',
    'ch5': 'だいごしょう。へいてんまでさんかげつ。語り、かしわぎはるか。',
    'ch6': 'だいろくしょう。できること。語り、にしのゆうま。',
    'ch7': 'だいななしょう。空の郵便が届くまで。語り、かしわぎはるか。',
}


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return float(r.stdout.strip())


def gen_split(text):
    text = ''.join(ln for ln in text.split('\n') if ln.strip() != '---')
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]


def spoken_chars(ch):
    return sum(len(s) for s in gen_split(ch['spoken']))


def measure_loudnorm(path):
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
    return meas


def silences(path, noise='-45dB', mindur=0.1):
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', path, '-af',
                        f'silencedetect=noise={noise}:d={mindur}', '-f', 'null', '-'],
                       capture_output=True, text=True)
    ivs, start = [], None
    for line in r.stderr.splitlines():
        m = re.search(r'silence_start: ([\d.]+)', line)
        if m:
            start = float(m.group(1))
        m = re.search(r'silence_end: ([\d.]+)', line)
        if m and start is not None:
            ivs.append((start, float(m.group(1))))
            start = None
    if start is not None:
        ivs.append((start, duration(path)))
    return ivs


def trim_edges(src, dst, head_keep=0.12, tail_keep=0.15):
    dur = duration(src)
    ivs = silences(src)
    start, end = 0.0, dur
    if ivs and ivs[0][0] <= 0.05:
        start = max(0.0, ivs[0][1] - head_keep)
    if ivs and ivs[-1][1] >= dur - 0.05:
        end = min(dur, ivs[-1][0] + tail_keep)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{start:.3f}', '-i', src,
                    '-t', f'{end - start:.3f}', '-ar', '24000', '-ac', '1', dst], check=True)
    return start, end


def build_one(src, chars, out_mp3, tag, trim=False):
    raw_dur = duration(src)
    cpm = chars / raw_dur * 60.0
    atempo = TARGET_CPM / cpm
    work_src = src
    if trim:
        trimmed = os.path.join(PROC, f'{tag}-trim.wav')
        trim_edges(src, trimmed)
        work_src = trimmed
        raw_dur = duration(work_src)
        cpm = chars / raw_dur * 60.0
        atempo = TARGET_CPM / cpm
    if trim:
        # 章題コールは自身の実測で 300 字/分へ寄せる（倍率はクランプする）
        atempo = max(0.85, min(1.45, atempo))
    adj = os.path.join(PROC, f'{tag}-adj.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', work_src,
                    '-af', f'atempo={atempo:.4f}', '-ar', '24000', '-ac', '1', adj], check=True)
    normed = os.path.join(PROC, f'{tag}-norm.wav')
    meas = normalize_wav(adj, normed)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', normed,
                    '-b:a', '64k', out_mp3], check=True)
    fin = duration(out_mp3)
    info = {'tag': tag, 'chars': chars, 'raw_duration': round(raw_dur, 2),
            'raw_cpm': round(cpm, 1), 'atempo': round(atempo, 4),
            'final_duration': round(fin, 2), 'final_cpm': round(chars / fin * 60.0, 1),
            'loudnorm_input_i': meas['input_i'] if meas else None}
    print(f"{tag}: raw {raw_dur:.1f}s ({cpm:.0f} cpm) atempo x{atempo:.3f} -> "
          f"{fin:.1f}s ({info['final_cpm']:.0f} cpm), input {info['loudnorm_input_i']} LUFS", flush=True)
    return info


def main():
    only = sys.argv[1:] or None
    report = {}
    rp = os.path.join(STAGE, 'build-report.json')
    if os.path.exists(rp):
        report = json.load(open(rp))
    for ch in DATA['chapters']:
        cid = ch['id']
        if only and cid not in only:
            continue
        raw = os.path.join(RAW, f'{cid}.wav')
        if not os.path.exists(raw):
            print(f'{cid}: raw missing, skip')
            continue
        report[cid] = build_one(raw, spoken_chars(ch), os.path.join(OUT, f'{cid}.mp3'), cid)
        traw = os.path.join(RAW, f'{cid}-title.wav')
        if os.path.exists(traw):
            report[f'{cid}-title'] = build_one(traw, len(CALLS[cid]),
                                               os.path.join(OUT, f'{cid}-title.mp3'),
                                               f'{cid}-title', trim=True)
    json.dump(report, open(rp, 'w'), ensure_ascii=False, indent=1)
    print('build report ->', rp)


if __name__ == '__main__':
    main()
