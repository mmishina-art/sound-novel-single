#!/usr/bin/env python3
"""制作ボイス版（Gemini 3.8 Flash・長文方式）の検証と unitTimes 構築。

1. 無音検出で文の境目を割り出し、文ごとの開始時刻を求める
   （期待位置＝字数比例を事前分布に、無音の再開点へ動的計画法で割り当てる）
2. 文ごとに音声を切り出して faster-whisper で文字起こしし、読み上げ文と
   突き合わせる（verify_gemini31.py と同じ物差し：ratio / lenratio / kana_ratio）
3. 章全体の文字起こしとも突き合わせ、欠落・繰り返し・崩れを検出する
4. 文の開始時刻をアプリ単位（表示文の 。 分割＋区切り）へ配分して
   unitTimes を作る（build_timings.py と同じ配分規則）
出力：work/gemini38/unitTimes.json、work/verify-gemini38.json
アプリ側ファイルには触らない（組み込み時に unitTimes を転記する）。
"""
import difflib, json, os, re, subprocess, sys
import numpy as np
from faster_whisper import WhisperModel
import pykakasi

BASE = os.path.expanduser('~/workspace/sound-novel-single')
WORK = os.path.join(BASE, 'work')
STAGE = os.path.join(WORK, 'gemini38')
AUDIO = os.path.join(STAGE, 'audio')
SEGOUT = os.path.join(STAGE, 'segments')
os.makedirs(SEGOUT, exist_ok=True)
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


def app_split(text):
    """logic.ts の splitSentences の再現（ルビ内では割らない）"""
    out, buf, in_ruby, i = [], '', False, 0
    while i < len(text):
        c = text[i]
        buf += c
        if c == '《':
            in_ruby = True
        elif c == '》':
            in_ruby = False
        elif c == '。' and not in_ruby:
            while i + 1 < len(text) and text[i + 1] in '」』）】〉・…':
                buf += text[i + 1]
                i += 1
            out.append(buf)
            buf = ''
        i += 1
    if buf:
        out.append(buf)
    return out


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return float(r.stdout.strip())


def silences(path, noise='-45dB', mindur=0.08):
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


def speech_span(path):
    dur = duration(path)
    ivs = silences(path)
    if not ivs:
        return 0.0, dur
    speech_start = ivs[0][1] if ivs[0][0] <= 0.05 else 0.0
    speech_end = ivs[-1][0] if ivs[-1][1] >= dur - 0.05 else dur
    return speech_start, speech_end


def align_starts(audio, sents, speech_start, speech_end, silence_ends=None):
    """章全体を単語タイムスタンプ付きで起こし、既知の読み上げ文（かな）へ
    文字単位でアラインして文の開始時刻を求める。無音ベースの割り当ては
    文中の息継ぎやポーズ分布で滑るため、こちらを正とする。
    戻り値: (starts, whole_heard_text)"""
    segs, _ = model.transcribe(audio, language='ja', word_timestamps=True)
    words = []
    whole = ''
    for s in segs:
        whole += s.text
        for w in (s.words or []):
            words.append(w)
    if not words:
        raise RuntimeError('no word timestamps')
    h_chars, h_times = [], []
    for w in words:
        k = to_kana(w.word)
        if not k:
            continue
        for i, c in enumerate(k):
            h_chars.append(c)
            h_times.append(w.start + (w.end - w.start) * (i / max(len(k), 1)))
    H = ''.join(h_chars)
    t_parts = [to_kana(s) for s in sents]
    T = ''.join(t_parts)
    sent_pos = []
    acc = 0
    for p in t_parts:
        sent_pos.append(acc)
        acc += len(p)
    sm = difflib.SequenceMatcher(None, T, H, autojunk=False)
    pos_map = {}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for d in range(i2 - i1):
                pos_map[i1 + d] = j1 + d
        else:
            pos_map.setdefault(i1, j1)
    starts = []
    last_t = speech_start
    for k, p in enumerate(sent_pos):
        if k == 0:
            starts.append(speech_start)
            continue
        j = pos_map.get(p)
        if j is None:
            cand = [q for q in pos_map if q <= p]
            j = pos_map[max(cand)] if cand else 0
        t = h_times[min(j, len(h_times) - 1)] if h_times else last_t
        if silence_ends:
            # 近傍（±1.2秒）に無音の終了点があれば、発話の立ち上がりに吸着させる
            near = [e for e in silence_ends if abs(e - t) <= 1.2]
            if near:
                t = min(near, key=lambda e: abs(e - t))
        t = max(t, last_t + 0.05)
        starts.append(round(t, 3))
        last_t = t
    return starts, whole


model = WhisperModel('small', device='cpu', compute_type='int8')


def transcribe_np(audio):
    segs, _ = model.transcribe(audio, language='ja')
    return ''.join(s.text for s in segs)


def load_audio(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le',
                          '-ar', '16000', '-ac', '1', '-'], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def score(target, heard):
    t, h = norm(target), norm(heard)
    ratio = difflib.SequenceMatcher(None, t, h, autojunk=False).ratio()
    lenratio = len(h) / max(len(t), 1)
    kratio = difflib.SequenceMatcher(None, to_kana(target), to_kana(heard),
                                     autojunk=False).ratio()
    flag = 'OK' if (ratio >= 0.82 and 0.75 <= lenratio <= 1.3) else 'CHECK'
    return {'heard': heard, 'target': target, 'ratio': round(ratio, 3),
            'lenratio': round(lenratio, 2), 'kana_ratio': round(kratio, 3), 'flag': flag}


def app_units(ch):
    """build_timings.py と同じ：表示単位列と、対応する spoken 単位列"""
    disp_paras = ch.get('ruby') or ch['paragraphs']
    disp = []
    for p in disp_paras:
        if p.strip() == '---':
            disp.append(True)
        else:
            for _ in app_split(p):
                disp.append(False)
    spoken_lines = ch['spoken'].split('\n')
    sp_units = []
    li = 0
    for p in disp_paras:
        if p.strip() == '---':
            while li < len(spoken_lines) and spoken_lines[li].strip() != '---':
                li += 1
            if li < len(spoken_lines):
                li += 1
            sp_units.append(None)
            continue
        while li < len(spoken_lines) and spoken_lines[li].strip() == '---':
            li += 1
        for s in app_split(spoken_lines[li]):
            sp_units.append(s)
        li += 1
    return disp, sp_units


def unit_times(ch, starts, speech_end, dur_total):
    sents = gen_split(ch['spoken'])
    ends = starts[1:] + [speech_end]
    disp, sp_units = app_units(ch)
    if len(sp_units) != len(disp):
        raise RuntimeError(f"unit count mismatch spoken {len(sp_units)} != display {len(disp)}")
    nrm = lambda s: re.sub(r'\s+', '', s)
    if nrm(''.join(sents)) != nrm(''.join(s for s in sp_units if s)):
        raise RuntimeError('spoken concat mismatch gen vs app units')
    real_starts = []
    gi, g_used = 0, 0.0
    for s in sp_units:
        if s is None:
            continue
        target = len(nrm(s))
        consumed, start_time = 0, None
        while consumed < target:
            g = nrm(sents[gi])
            avail = len(g) - g_used
            take = min(avail, target - consumed)
            if start_time is None:
                frac = g_used / len(g) if len(g) else 0.0
                start_time = starts[gi] + frac * (ends[gi] - starts[gi])
            consumed += take
            g_used += take
            if g_used >= len(g):
                gi += 1
                g_used = 0.0
        real_starts.append(start_time)
    if gi != len(sents):
        raise RuntimeError(f'could not distribute all gen sentences ({gi}/{len(sents)})')
    times, ri = [], 0
    for is_sep in disp:
        if is_sep:
            times.append(real_starts[ri] if ri < len(real_starts) else dur_total)
        else:
            times.append(real_starts[ri])
            ri += 1
    if any(times[i] > times[i + 1] + 1e-9 for i in range(len(times) - 1)):
        raise RuntimeError('unitTimes not monotonic')
    return [round(t, 3) for t in times]


def verify_chapter(ch):
    cid = ch['id']
    mp3 = os.path.join(AUDIO, f'{cid}.mp3')
    sents = gen_split(ch['spoken'])
    audio = load_audio(mp3)
    sr = 16000
    speech_start, speech_end = speech_span(mp3)
    s_ends = [e for (s, e) in silences(mp3) if speech_start < e < speech_end]
    starts, whole = align_starts(audio, sents, speech_start, speech_end,
                                 silence_ends=s_ends)
    dur_total = duration(mp3)
    res = {'chapter': cid, 'sentences': len(sents), 'duration': round(dur_total, 2),
           'speech_start': round(speech_start, 3), 'speech_end': round(speech_end, 3),
           'starts': [round(s, 3) for s in starts], 'results': []}
    for j, sent in enumerate(sents):
        a = starts[j]
        b = starts[j + 1] if j + 1 < len(starts) else speech_end
        # 切り出しは少しだけ前後に余裕を持たせ、判定は文そのものと行う
        seg = audio[int(max(0.0, a - 0.05) * sr):int(min(dur_total, b + 0.05) * sr)]
        heard = transcribe_np(seg)
        sc = score(sent, heard)
        sc['index'] = j
        sc['start'] = round(a, 2)
        res['results'].append(sc)
    res['whole'] = score(''.join(sents), whole)
    ut = unit_times(ch, starts, speech_end, dur_total)
    res['unitTimes'] = ut
    res['unit_count'] = len(ut)
    res['expected_unit_count'] = len(ch['unitTimes'])
    tpath = os.path.join(AUDIO, f'{cid}-title.mp3')
    if os.path.exists(tpath):
        res['title'] = score(CALLS[cid], transcribe_np(load_audio(tpath)))
    ok = sum(1 for r in res['results'] if r['flag'] == 'OK')
    print(f"{cid}: sentences OK {ok}/{len(sents)}, whole kana {res['whole']['kana_ratio']} "
          f"ratio {res['whole']['ratio']}, title kana {res.get('title', {}).get('kana_ratio')}, "
          f"units {len(ut)}/{len(ch['unitTimes'])}", flush=True)
    return res


def main():
    only = sys.argv[1:] or None
    out_path = os.path.join(WORK, 'verify-gemini38.json')
    results = json.load(open(out_path)) if os.path.exists(out_path) else {}
    utimes = {}
    ut_path = os.path.join(STAGE, 'unitTimes.json')
    if os.path.exists(ut_path):
        utimes = json.load(open(ut_path))
    for ch in DATA['chapters']:
        cid = ch['id']
        if only and cid not in only:
            continue
        if not os.path.exists(os.path.join(AUDIO, f'{cid}.mp3')):
            print(f'{cid}: staging mp3 missing, skip')
            continue
        r = verify_chapter(ch)
        results[cid] = r
        utimes[cid] = r['unitTimes']
        json.dump(results, open(out_path, 'w'), ensure_ascii=False, indent=1)
        json.dump(utimes, open(ut_path, 'w'), ensure_ascii=False, indent=1)
    print('verify ->', out_path)
    print('unitTimes ->', ut_path)


if __name__ == '__main__':
    main()
