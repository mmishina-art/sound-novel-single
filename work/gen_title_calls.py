#!/usr/bin/env python3
"""章題コール（扉の朗読）音声の生成：各章の扉に書かれた内容を、その章の語り手の声で読む短い音声。

- 対象：全7章。ファイル名は public/book/audio/ch{N}-title.mp3（本文音声とは別ファイル。
  本文の文字位置⇔時刻の対応には一切触れない）
- 声：本編と同じ（女性章=avocado_v2:Lily speed 112／男性章=avocado_v2:MAI_03 speed 90
  ＋その章の atempo（本編 stats-mai.json の値）でテンポ感を本編にそろえる）
- 生成は本編と同じく文単位： 「第N章」「題」「語り、名前」の3文を別々に合成し、
  0.3秒の無音を挟んでつなぐ（1回で読ませると、文脈で名前の読みが揺れることがあるため）
- 読み上げ文（spoken）は本編の読み監査で確定した読みに合わせ、誤読しやすい語はかなで固定する：
  章番号は だい〜しょう、取り置き→とりおき、閉店→へいてん、三か月→さんかげつ、
  名前は かしわぎはるか／にしのゆうま
- 生成後に faster-whisper で文字起こしし、意図した文と一致するか確認する（verify_title_calls.py）
"""
import json, os, subprocess, sys, time

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
RAW = os.path.join(WORK, 'title-raw')
AUDIO = os.path.join(BASE, 'audio')
APP_AUDIO = os.path.join(BASE, 'public', 'book', 'audio')
os.makedirs(RAW, exist_ok=True)
TTS = '/opt/hatch/bin/tts'
GAP_SEC = 0.3

# 章ごとのコール文（文単位に分割済み）
CALLS = [
    ('ch1', 'female', ['だいいっしょう。', '雨の日の客。', '語り、かしわぎはるか。']),
    ('ch2', 'male',   ['だいにしょう。', '忘れ物の傘。', '語り、にしのゆうま。']),
    ('ch3', 'female', ['だいさんしょう。', 'とりおきの本。', '語り、かしわぎはるか。']),
    ('ch4', 'male',   ['だいよんしょう。', '感想の宿題。', '語り、にしのゆうま。']),
    ('ch5', 'female', ['だいごしょう。', 'へいてんまでさんかげつ。', '語り、かしわぎはるか。']),
    ('ch6', 'male',   ['だいろくしょう。', 'できること。', '語り、にしのゆうま。']),
    ('ch7', 'female', ['だいななしょう。', '空の郵便が届くまで。', '語り、かしわぎはるか。']),
]
MALE_ATEMPO = {'ch2': 0.8463, 'ch4': 0.8610, 'ch6': 0.8301}  # 本編 stats-mai.json の章別 atempo


def duration_of(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return float(r.stdout.strip())


def atempo_filter(f):
    # atempo は 0.5〜2.0 の範囲でしか使えないため、必要な場合は段を重ねる（本編 gen.py と同じ流儀）
    chain, rest = [], f
    while rest < 0.5:
        chain.append(0.5)
        rest /= 0.5
    chain.append(rest)
    return ','.join(f'atempo={c}' for c in chain)


def synth_segment(cid, idx, narrator, text):
    raw = os.path.join(RAW, f'{cid}-title-{idx}.mp3')
    if os.path.exists(raw) and os.path.getsize(raw) > 500:
        return raw
    voice, speed = ('avocado_v2:Lily', 112) if narrator == 'female' else ('avocado_v2:MAI_03', 90)
    for attempt in range(5):
        if attempt:
            time.sleep([5, 15, 30, 60][attempt - 1])
        r = subprocess.run([TTS, 'speak', '--output', raw, '--voice', voice, '--language', 'ja_JP',
                            '--speed', str(speed), '--text-stdin'],
                           input=text.encode(), capture_output=True, timeout=180)
        if r.returncode == 0 and os.path.exists(raw) and os.path.getsize(raw) > 500:
            return raw
        print(f'  retry {cid}-{idx} attempt {attempt}: rc={r.returncode}')
    raise RuntimeError(f'synth failed: {cid}-{idx}')


def trim_segment(cid, idx, raw):
    """文の前後の無音を詰める（頭は 0.12 秒、尻は 0.10 秒だけ残す）。
    TTS の出力は文ごとに頭の無音量がばらつき（最大0.8秒）、そのままつなぐと
    コールの出だしが遅れ、間も間延びするため。文中の間（読点のポーズ等）には触らない"""
    out = os.path.join(RAW, f'{cid}-title-{idx}-trimmed.mp3')
    if os.path.exists(out):
        return out
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', raw, '-af',
                        'silencedetect=noise=-45dB:d=0.1', '-f', 'null', '-'],
                       capture_output=True, text=True)
    dur = duration_of(raw)
    head_end, tail_start = 0.0, dur
    pairs = []  # (無音の開始, 終了) の組
    pending = None
    for line in r.stderr.splitlines():
        if 'silence_start:' in line:
            pending = float(line.split('silence_start:')[1].strip())
        elif 'silence_end:' in line and pending is not None:
            pairs.append((pending, float(line.split('silence_end:')[1].split('|')[0].strip())))
            pending = None
    if pairs and pairs[0][0] <= 0.01:
        head_end = pairs[0][1]  # 先頭の無音が終わる位置
    if pairs and abs(pairs[-1][1] - dur) <= 0.05:
        tail_start = pairs[-1][0]  # 末尾の無音が始まる位置
    start = max(0.0, head_end - 0.12)
    end = min(dur, tail_start + 0.10)
    if end - start < 0.3:  # 想定外に短くなる場合は元のまま使う
        return raw
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', raw,
                    '-af', f'atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS',
                    '-ar', '24000', '-ac', '1', '-b:a', '64k', out], check=True)
    return out


def build_call(cid, narrator, segments):
    parts = []
    for i, text in enumerate(segments):
        raw = trim_segment(cid, i, synth_segment(cid, i, narrator, text))
        if narrator == 'male':
            stretched = os.path.join(RAW, f'{cid}-title-{i}-stretched.mp3')
            if not os.path.exists(stretched):
                subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', raw,
                                '-af', atempo_filter(MALE_ATEMPO[cid]),
                                '-ar', '24000', '-ac', '1', '-b:a', '64k', stretched], check=True)
            parts.append(stretched)
        else:
            parts.append(raw)
    # 文間に 0.3 秒の無音を挟んで連結する（本編の組み立てと同じ）。
    # 各パートを「発話 + 0.3s」に整えてから連結する
    inputs = []
    for p in parts:
        inputs += ['-i', p]
    filt_parts = []
    for i in range(len(parts)):
        filt_parts.append(f'[{i}:a]aresample=24000,apad,atrim=end={duration_of(parts[i]) + GAP_SEC:.3f}[p{i}]')
    filt = ';'.join(filt_parts) + ';' + ''.join(f'[p{i}]' for i in range(len(parts))) + \
        f'concat=n={len(parts)}:v=0:a=1[out]'
    out = os.path.join(RAW, f'{cid}-title-joined.mp3')
    subprocess.run(['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', filt,
                    '-map', '[out]', '-ar', '24000', '-ac', '1', '-b:a', '64k', out], check=True)
    return out


def main():
    only = sys.argv[1:] or None
    for cid, narrator, segments in CALLS:
        if only and cid not in only:
            continue
        print(f'{cid}: {" ".join(segments)}')
        joined = build_call(cid, narrator, segments)
        n = cid[2:]
        for dest_dir in (AUDIO, APP_AUDIO):
            subprocess.run(['cp', joined, os.path.join(dest_dir, f'ch{n}-title.mp3')], check=True)
        out = os.path.join(APP_AUDIO, f'ch{n}-title.mp3')
        print(f'  -> {out} ({duration_of(out):.2f}s)')


if __name__ == '__main__':
    main()
