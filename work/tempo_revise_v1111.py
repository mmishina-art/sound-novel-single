#!/usr/bin/env python3
"""v1.11.1 テンポ改定：男性章(Charon)を350字/分へ、女性章(Leda)を生速度へ。

- 男性章 ch2/4/6 本文：raw WAV から atempo で実測350字/分に再補正
- 男性章の章題コール：従来の倍率 × 350/300 で追随（端末無音トリムは従来どおり）
- 女性章 ch1/3/5/7 本文・章題コール：atempo なし（生速度）。音量統一のみ
- 音量は build_gemini38_single.py と同一の loudnorm 2パス（−25 LUFS設定、全章実測 −25.4）
- unitTimes はステージング実測アライメントを「新尺/旧尺」の比率で換算し、
  文数・単調性・総尺との整合を機械確認する。アプリ用は先頭単位を 0 に寄せる（従来規約）
- 生成APIは一切叩かない（raw WAV の再加工のみ）
"""
import importlib.util, json, os, subprocess, sys

BASE = os.path.expanduser('~/workspace/sound-novel-single')
STAGE = os.path.join(BASE, 'work', 'gemini38')
RAW = os.path.join(STAGE, 'raw')
PROC = os.path.join(STAGE, 'proc')
OUT = os.path.join(STAGE, 'audio')
PREV = '/tmp/prev1110/audio'  # v1.11.0 のステージングMP3（尺比率の分母）

spec = importlib.util.spec_from_file_location('b38', os.path.join(BASE, 'work', 'build_gemini38_single.py'))
b38 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b38)

MALE = ['ch2', 'ch4', 'ch6']
FEMALE = ['ch1', 'ch3', 'ch5', 'ch7']
MALE_TARGET = 350.0
DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
CHMAP = {c['id']: c for c in DATA['chapters']}
OLD_REPORT = json.load(open(os.path.join(STAGE, 'build-report.json')))


def encode(normed_wav, out_mp3):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', normed_wav,
                    '-b:a', '64k', out_mp3], check=True)


def process(tag, src, chars, atempo, trim):
    """trim → atempo(1.0なら素通し) → loudnorm → mp3。計測 dict を返す。"""
    work_src = src
    raw_dur = b38.duration(src)
    if trim:
        trimmed = os.path.join(PROC, f'{tag}-v1111-trim.wav')
        b38.trim_edges(src, trimmed)
        work_src = trimmed
        raw_dur = b38.duration(work_src)
    adj = os.path.join(PROC, f'{tag}-v1111-adj.wav')
    if abs(atempo - 1.0) < 1e-9:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', work_src,
                        '-ar', '24000', '-ac', '1', adj], check=True)
    else:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', work_src,
                        '-af', f'atempo={atempo:.4f}', '-ar', '24000', '-ac', '1', adj], check=True)
    normed = os.path.join(PROC, f'{tag}-v1111-norm.wav')
    meas = b38.normalize_wav(adj, normed)
    out_mp3 = os.path.join(OUT, f'{tag}.mp3')
    encode(normed, out_mp3)
    fin = b38.duration(out_mp3)
    loud = b38.measure_loudnorm(out_mp3)
    info = {'tag': tag, 'chars': chars, 'raw_duration': round(raw_dur, 2),
            'raw_cpm': round(chars / raw_dur * 60.0, 1), 'atempo': round(atempo, 4),
            'final_duration': round(fin, 2), 'final_cpm': round(chars / fin * 60.0, 1),
            'loudnorm_input_i': meas['input_i'] if meas else None,
            'final_lufs': loud['input_i'] if loud else None,
            'revised': 'v1.11.1'}
    print(f"{tag}: base {raw_dur:.1f}s ({info['raw_cpm']:.0f} cpm) atempo x{atempo:.4f} -> "
          f"{fin:.1f}s ({info['final_cpm']:.0f} cpm), final {info['final_lufs']} LUFS", flush=True)
    return info


def main():
    report = dict(OLD_REPORT)
    new_dur = {}
    # 本文
    for cid in MALE + FEMALE:
        chars = b38.spoken_chars(CHMAP[cid])
        raw = os.path.join(RAW, f'{cid}.wav')
        raw_cpm = chars / b38.duration(raw) * 60.0
        atempo = (MALE_TARGET / raw_cpm) if cid in MALE else 1.0
        report[cid] = process(cid, raw, chars, atempo, trim=False)
        new_dur[cid] = report[cid]['final_duration']
    # 章題コール
    for cid in MALE + FEMALE:
        tag = f'{cid}-title'
        chars = len(b38.CALLS[cid])
        raw = os.path.join(RAW, f'{tag}.wav')
        if cid in MALE:
            atempo = OLD_REPORT[tag]['atempo'] * (MALE_TARGET / 300.0)
        else:
            atempo = 1.0
        report[tag] = process(tag, raw, chars, atempo, trim=True)
    json.dump(report, open(os.path.join(STAGE, 'build-report.json'), 'w'),
              ensure_ascii=False, indent=1)

    # unitTimes 換算（ステージング実測 → 新尺。比率 = 新MP3尺 / 旧MP3尺）
    staged = json.load(open(os.path.join(STAGE, 'unitTimes.json')))
    app = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
    for ch in app['chapters']:
        cid = ch['id']
        old_d = b38.duration(os.path.join(PREV, f'{cid}.mp3'))
        new_d = b38.duration(os.path.join(OUT, f'{cid}.mp3'))
        ratio = new_d / old_d
        old_times = staged[cid]
        new_times = [round(t * ratio, 3) for t in old_times]
        # 機械確認：文数一致・単調非減少・末尾（区切り単位=総尺）が新尺と一致
        assert len(new_times) == len(ch['unitTimes']), f'{cid}: unit count mismatch'
        assert all(new_times[i] >= new_times[i - 1] for i in range(1, len(new_times))), f'{cid}: not monotonic'
        assert new_times[-1] <= new_d + 0.05, f'{cid}: last {new_times[-1]} > dur {new_d}'
        staged[cid] = new_times
        app_times = list(new_times)
        app_times[0] = 0  # アプリ規約：先頭単位は 0
        ch['unitTimes'] = app_times
        print(f'{cid}: unitTimes x{ratio:.4f} (old {old_d:.2f}s -> new {new_d:.2f}s), '
              f'{len(new_times)} units, last {new_times[-1]}', flush=True)
    json.dump(staged, open(os.path.join(STAGE, 'unitTimes.json'), 'w'), ensure_ascii=False, indent=1)
    with open(os.path.join(BASE, 'data', 'chapters.json'), 'w') as f:
        json.dump(app, f, ensure_ascii=False, indent=1)
    subprocess.run(['cp', os.path.join(BASE, 'data', 'chapters.json'),
                    os.path.join(BASE, 'public', 'book', 'data.json')], check=True)
    print('unitTimes + data updated')


if __name__ == '__main__':
    main()
