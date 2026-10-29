#!/usr/bin/env python3
"""制作ボイス版（Gemini 3.1）の検証：文セグメントと完成章MP3を全数文字起こしする。

- 文単位：work/gemini31-stretched/ch{N}-{j}.wav を faster-whisper で起こし、
  対応する読み上げ文（spoken の生成側分割）と正規化して突き合わせる
- 章単位：audio/gemini31/ch{N}.mp3 全体を起こして spoken 全文と突き合わせ（結合漏れ検出）
- 章題コール：audio/gemini31/ch{N}-title.mp3 を起こしてコール文と突き合わせる
- 併記指標として pykakasi かな化の類似度も出す（同音異字の切り分け用）
結果は work/verify-gemini31.json に保存。CHECK の文は gen 側で作り直す対象。
"""
import difflib, json, os, re, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel
import pykakasi

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
STRETCHED = os.path.join(WORK, 'gemini31-stretched')
OUT_AUDIO = os.path.join(BASE, 'audio', 'gemini31')
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
_kks = pykakasi.kakasi()


def norm(s):
    return re.sub(r'[、。！？『』「」・…―／\s,.!?%％"“”‘’\-]', '', s)


def to_kana(s):
    hira = ''.join(x['hira'] for x in _kks.convert(s))
    hira = ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in hira)
    return norm(hira)


def gen_split(text):
    text = ''.join(ln for ln in text.split('\n') if ln.strip() != '---')
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]


def clean_text(spoken):
    return ''.join([ln for ln in spoken.split('\n') if ln.strip() != '---'])


model = WhisperModel('small', device='cpu', compute_type='int8')


def transcribe(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le',
                          '-ar', '16000', '-ac', '1', '-'], capture_output=True).stdout
    segs, _ = model.transcribe(np.frombuffer(raw, dtype=np.float32), language='ja')
    return ''.join(s.text for s in segs)


def score(target, heard):
    t, h = norm(target), norm(heard)
    ratio = difflib.SequenceMatcher(None, t, h).ratio()
    lenratio = len(h) / max(len(t), 1)
    tk, hk = to_kana(target), to_kana(heard)
    kratio = difflib.SequenceMatcher(None, tk, hk).ratio()
    flag = 'OK' if (ratio >= 0.82 and 0.75 <= lenratio <= 1.3) else 'CHECK'
    return {'heard': heard, 'target': target, 'ratio': round(ratio, 3),
            'lenratio': round(lenratio, 2), 'kana_ratio': round(kratio, 3), 'flag': flag}


def main():
    only = sys.argv[1:] or None
    out_path = os.path.join(WORK, 'verify-gemini31.json')
    results = json.load(open(out_path)) if os.path.exists(out_path) else {}
    for ch in DATA['chapters']:
        cid = ch['id']
        if only and cid not in only:
            continue
        sents = gen_split(ch['spoken'])
        entry = results.setdefault(cid, {'sentences': {}})
        bad = 0
        for j, s in enumerate(sents):
            wav = os.path.join(STRETCHED, f'{cid}-{j}.wav')
            if not os.path.exists(wav):
                print(f'{cid}-{j}: MISSING segment', flush=True)
                bad += 1
                continue
            r = score(s, transcribe(wav))
            entry['sentences'][str(j)] = r
            if r['flag'] != 'OK':
                bad += 1
                print(f'--- {cid}-{j} [CHECK] sim={r["ratio"]:.2f} len={r["lenratio"]:.2f} '
                      f'kana={r["kana_ratio"]:.2f}', flush=True)
                print(f'  目標: {s}', flush=True)
                print(f'  聞取: {r["heard"]}', flush=True)
        print(f'== {cid}: sentences checked, CHECK={bad}/{len(sents)}', flush=True)
        mp3 = os.path.join(OUT_AUDIO, f'{cid}.mp3')
        if os.path.exists(mp3):
            entry['chapter'] = score(clean_text(ch['spoken']), transcribe(mp3))
            print(f'== {cid} chapter [{entry["chapter"]["flag"]}] '
                  f'sim={entry["chapter"]["ratio"]:.2f}', flush=True)
        t_mp3 = os.path.join(OUT_AUDIO, f'{cid}-title.mp3')
        if os.path.exists(t_mp3):
            entry['title'] = score(CALLS[cid], transcribe(t_mp3))
            print(f'== {cid} title [{entry["title"]["flag"]}] '
                  f'sim={entry["title"]["ratio"]:.2f} heard={entry["title"]["heard"]}', flush=True)
        results[cid] = entry
        json.dump(results, open(out_path, 'w'), ensure_ascii=False, indent=1)
    print(f'== saved {out_path}')


if __name__ == '__main__':
    main()
