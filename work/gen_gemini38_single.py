#!/usr/bin/env python3
"""『空の郵便が届くまで』制作ボイス版（Gemini 3.8 Flash TTS・長文方式）の生成。

ユーザー決定（2026-10-29）：3.1 版の制作を中止し、3.8 Flash で作り直す。
- モデルは全章共通 gemini-3.8-flash-tts（同じ本でモデルを混ぜない）
- 女性章 = Leda ＋ 透明感・儚さのスタイル、男性章 = Charon ＋ SOFT スタイル
  （スタイル文は分岐ノベル側の本番条件と同一。speechMetadata に分離し本文に混ぜない）
- 本文は 1 章 = 1 回の長文生成。章題コールも章ごとに 1 回で生成する
- 読み上げ文（spoken）は data/chapters.json の監査確定値をそのまま使う
- 素材は work/gemini38/raw/ に残す（再開可能・既存はスキップ）
組み立て（atempo・正規化・unitTimes・検証）は build_gemini38_single.py /
verify_gemini38_single.py が担う。アプリ側ファイルには触らない。
"""
import json, os, subprocess, sys, time

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
STAGE = os.path.join(WORK, 'gemini38')
RAW = os.path.join(STAGE, 'raw')
TEXTS = os.path.join(STAGE, 'texts')
os.makedirs(RAW, exist_ok=True)
os.makedirs(TEXTS, exist_ok=True)

HELPER = os.path.expanduser('~/workspace/simple_visual_novel/scripts/gemini38_tts.py')
MODEL = 'gemini-3.8-flash-tts'
STYLE_F = '小説の朗読です。透明感のある、儚げで柔らかい声で読んでください。澄んだ静けさを保ち、囁かずに自然な声量で、穏やかに読んでください'
STYLE_M = '小説の朗読です。やわらかく穏やかな男性の声で読んでください。強さや格好よさは抑えて、親しみやすく、静かに寄り添うような語り口で読んでください'
VOICE = {'female': ('Leda', STYLE_F), 'male': ('Charon', STYLE_M)}

# 章題コールの読み上げ文（gen_title_calls.py / verify_gemini31.py の監査確定値と同一）
CALLS = {
    'ch1': 'だいいっしょう。雨の日の客。語り、かしわぎはるか。',
    'ch2': 'だいにしょう。忘れ物の傘。語り、にしのゆうま。',
    'ch3': 'だいさんしょう。とりおきの本。語り、かしわぎはるか。',
    'ch4': 'だいよんしょう。感想の宿題。語り、にしのゆうま。',
    'ch5': 'だいごしょう。へいてんまでさんかげつ。語り、かしわぎはるか。',
    'ch6': 'だいろくしょう。できること。語り、にしのゆうま。',
    'ch7': 'だいななしょう。空の郵便が届くまで。語り、かしわぎはるか。',
}

DATA = json.load(open(os.path.join(BASE, 'data', 'chapters.json')))


def body_text(ch):
    """spoken から区切り行（---）を除き、段落の改行を保って長文入力にする"""
    lines = []
    for ln in ch['spoken'].split('\n'):
        if ln.strip() == '---':
            lines.append('')
        else:
            lines.append(ln)
    return '\n'.join(lines).strip()


def synth(text, voice, style, out_wav, tag):
    tf = os.path.join(TEXTS, f'{tag}.txt')
    with open(tf, 'w', encoding='utf-8') as fh:
        fh.write(text)
    for attempt in range(3):
        r = subprocess.run(['python3', HELPER, tf, voice, out_wav, MODEL, style],
                           capture_output=True, text=True, timeout=600)
        if r.returncode == 0 and os.path.exists(out_wav) and os.path.getsize(out_wav) > 5000:
            print(f'  ok {tag}: {r.stdout.strip()}', flush=True)
            return True
        err = (r.stderr or r.stdout or '')[-400:]
        print(f'  fail {tag} attempt {attempt + 1}: {err}', flush=True)
        time.sleep(60 * (attempt + 1))
    return False


def main():
    only = sys.argv[1:] or None
    failed = []
    for ch in DATA['chapters']:
        cid = ch['id']
        if only and cid not in only:
            continue
        voice, style = VOICE[ch['narrator']]
        jobs = [(f'{cid}', body_text(ch)), (f'{cid}-title', CALLS[cid])]
        for tag, text in jobs:
            out = os.path.join(RAW, f'{tag}.wav')
            if os.path.exists(out) and os.path.getsize(out) > 5000:
                print(f'skip {tag} (exists)', flush=True)
                continue
            print(f'gen {tag} voice={voice} chars={len(text)}', flush=True)
            if not synth(text, voice, style, out, tag):
                failed.append(tag)
            time.sleep(30)
    if failed:
        print('FAILED:', failed)
        sys.exit(1)
    print('all generation done')


if __name__ == '__main__':
    main()
