#!/usr/bin/env python3
"""『空の郵便が届くまで』制作ボイス版（Gemini 3.1 Flash TTS）の文単位生成。

確定レシピ（2026-10-28 ユーザー決定）：
- モデルは全章共通 gemini-3.1-flash-tts-preview（同じ本でモデルを混ぜない）
- 女性章 = Leda ＋ 透明感・儚さのスタイル指示、男性章 = Charon ＋ SOFT スタイル
- 文（。！？）単位で合成（文分割は build_timings.py の生成側分割と同一規則）
- 呼び出し間隔は75秒（2026-10-29 実測で判明した小さなバースト枠に合わせた定常ペース）。
  429 が出たら 180→300→420 秒と待機を延ばして最大3回まで再試行し、
  それでも 429 なら打ち切って終了する（枠の回復待ち。無理な連打はしない）
- 素材は work/gemini31-raw/ch{N}-{j}.wav に文単位で残す（再開可能・既存はスキップ）
- 各章の本文が揃った直後に、その章の章題コール3文（ch{N}-title-{k}.wav）も生成する
- 読み上げ文（spoken）は data/chapters.json の監査確定値をそのまま使う

組み立て（atempo・結合・unitTimes）は build_gemini31.py ＋ build_timings.py が担う。
"""
import json, os, re, subprocess, sys, time

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
RAW = os.path.join(WORK, 'gemini31-raw')
os.makedirs(RAW, exist_ok=True)
HELPER = os.path.expanduser('~/workspace/custom-connectors/custom.google-gemini-api/bin/gemini_tts.py')
MODEL = 'gemini-3.1-flash-tts-preview'

STYLE_F = '小説の朗読です。透明感のある、儚げで柔らかい声で読んでください。澄んだ静けさを保ち、囁かずに自然な声量で、穏やかに読んでください:\n'
STYLE_M = '小説の朗読です。やわらかく穏やかな男性の声で読んでください。強さや格好よさは抑えて、親しみやすく、静かに寄り添うような語り口で読んでください:\n'
VOICE = {'female': ('Leda', STYLE_F), 'male': ('Charon', STYLE_M)}

# 章題コールの読み上げ文（gen_title_calls.py の監査確定値と同一）
CALLS = {
    'ch1': ['だいいっしょう。', '雨の日の客。', '語り、かしわぎはるか。'],
    'ch2': ['だいにしょう。', '忘れ物の傘。', '語り、にしのゆうま。'],
    'ch3': ['だいさんしょう。', 'とりおきの本。', '語り、かしわぎはるか。'],
    'ch4': ['だいよんしょう。', '感想の宿題。', '語り、にしのゆうま。'],
    'ch5': ['だいごしょう。', 'へいてんまでさんかげつ。', '語り、かしわぎはるか。'],
    'ch6': ['だいろくしょう。', 'できること。', '語り、にしのゆうま。'],
    'ch7': ['だいななしょう。', '空の郵便が届くまで。', '語り、かしわぎはるか。'],
}

DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))
STATS_PATH = os.path.join(WORK, 'stats-gemini31.json')
stats = json.load(open(STATS_PATH)) if os.path.exists(STATS_PATH) else {
    'api_calls': 0, 'api_failures': 0, 'quota_aborted': False, 'sentences_done': {}}
stats.setdefault('sentences_done', {})


def save_stats():
    json.dump(stats, open(STATS_PATH, 'w'), ensure_ascii=False, indent=1)


def gen_split(text):
    """生成側の文分割（build_timings.py の gen_split と同一）"""
    text = ''.join(ln for ln in text.split('\n') if ln.strip() != '---')
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]


class QuotaAbort(Exception):
    pass


RATE_WAITS = [180, 300, 420]  # 429 時の待機（秒）。最大3回まで粘ってから打ち切る


def synth(tf, voice, out_wav):
    """1文を合成。429 は待機を延ばしながら最大3回再試行し、なお 429 なら QuotaAbort。
    非429の失敗は1回だけ間を置いて再試行し、ダメなら False（次回実行に残す）。"""
    retries_429 = 0
    retried_other = False
    while True:
        stats['api_calls'] += 1
        save_stats()
        r = subprocess.run(['python3', HELPER, tf, voice, out_wav, MODEL],
                           capture_output=True, text=True, timeout=300)
        if r.returncode == 0 and os.path.exists(out_wav) and os.path.getsize(out_wav) > 1000:
            return True
        stats['api_failures'] += 1
        save_stats()
        err = (r.stderr or r.stdout or '')[-300:]
        print(f'  API fail (429 retries={retries_429}): {err}', flush=True)
        if '429' in err:
            if retries_429 < len(RATE_WAITS):
                w = RATE_WAITS[retries_429]
                retries_429 += 1
                print(f'  429: wait {w}s and retry ({retries_429}/{len(RATE_WAITS)})', flush=True)
                time.sleep(w)
                continue
            raise QuotaAbort('429 persisted after long waits; quota likely exhausted for now')
        if not retried_other:
            retried_other = True
            time.sleep(120)
            continue
        return False


def main():
    only = sys.argv[1:] or None
    try:
        for ch in DATA['chapters']:
            cid = ch['id']
            if only and cid not in only:
                continue
            voice, style = VOICE[ch['narrator']]
            sents = gen_split(ch['spoken'])
            print(f'== {cid} ({ch["narrator"]}/{voice}): {len(sents)} sentences', flush=True)
            for j, s in enumerate(sents):
                w = os.path.join(RAW, f'{cid}-{j}.wav')
                if os.path.exists(w) and os.path.getsize(w) > 1000:
                    continue
                tf = os.path.join(RAW, f'{cid}-{j}.txt')
                open(tf, 'w').write(style + s)
                if not synth(tf, voice, w):
                    print(f'  !! {cid}-{j} failed (non-429); leaving for next run', flush=True)
                    continue
                stats['sentences_done'][f'{cid}-{j}'] = True
                save_stats()
                print(f'  {cid}-{j} done: {s[:20]}...', flush=True)
                time.sleep(75)
            # 章題コール（本文が全て揃った章だけ）
            if all(os.path.exists(os.path.join(RAW, f'{cid}-{j}.wav')) for j in range(len(sents))):
                for k, s in enumerate(CALLS[cid]):
                    w = os.path.join(RAW, f'{cid}-title-{k}.wav')
                    if os.path.exists(w) and os.path.getsize(w) > 1000:
                        continue
                    tf = os.path.join(RAW, f'{cid}-title-{k}.txt')
                    open(tf, 'w').write(style + s)
                    if not synth(tf, voice, w):
                        print(f'  !! {cid}-title-{k} failed; leaving for next run', flush=True)
                        continue
                    stats['sentences_done'][f'{cid}-title-{k}'] = True
                    save_stats()
                    print(f'  {cid}-title-{k} done', flush=True)
                    time.sleep(75)
    except QuotaAbort as e:
        stats['quota_aborted'] = True
        save_stats()
        print(f'QUOTA ABORT: {e}', flush=True)
    done = sum(1 for ch in DATA['chapters']
               if all(os.path.exists(os.path.join(RAW, f"{ch['id']}-{j}.wav"))
                      for j in range(len(gen_split(ch['spoken'])))))
    print(f'GEN PROGRESS: {done}/7 chapters complete, api_calls={stats["api_calls"]}, '
          f'failures={stats["api_failures"]}, quota_aborted={stats["quota_aborted"]}', flush=True)


if __name__ == '__main__':
    main()
