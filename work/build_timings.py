#!/usr/bin/env python3
"""文単位の実開始時刻（unitTimes）を本のデータへ埋め込む。

背景：アプリはもともと「音声の時刻 → 表示文字数の比例」で朗読位置を推定していたが、
実際の朗読は文ごとに間（文間0.3秒）や読みの速度が一定でなく、推定が実位置から
最大で数秒（1文分以上）ずれることが実測で分かった（ハイライト・ページ追従・
カラオケ表示がそろってずれる不具合の根本原因）。
そこで、生成済みの文セグメント音声の尺から「各文が音声の何秒目に始まるか」を
実測してデータに持たせ、アプリは推定ではなく実時刻で位置を決める。

材料：
- data/chapters.json（spoken＝かな固定の読み上げ文、ruby＝表示文）
- 文セグメント音声：女性章は work/muse-raw/ch{N}-{j}.mp3、男性章は
  work/mai-stretched/ch{N}-{j}.mp3（atempo 適用後の結合素材）。
  セグメントの並びは生成側の文分割（。！？で割る）の順。
- 結合は文間に 0.3 秒の無音（GAP_SEC）を挟む（gen_muse.py / gen_mai.py と同じ）。

対応付け：生成文の連結と、アプリ単位（表示側の文分割＝。のみで割る）に割った
読み上げ文の連結が一致することを確認したうえで、生成文をアプリ単位へ順に
配分する。単位境界が生成文の途中に来る場合は、その文の時間を文字数比例で分ける。

検証（1つでも外れたら書き込まずに異常終了する）：
- 生成文の数 == セグメントファイルの数
- セグメント尺＋文間無音の合計 == 完成MP3（public/book/audio/ch{N}.mp3）の尺（±0.2秒）
- アプリ単位の数（区切り単位を含む）がアプリ側 buildUnits と一致
- unitTimes が単調非減少で、最後の文の開始が総尺未満

使い方：work/build_data.py のあと、音声を生成・差し替えたあとに実行する。
出力：data/chapters.json と public/book/data.json の各章へ unitTimes を追加。
"""
import glob
import json
import os
import re
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(BASE, 'work')
GAP_SEC = 0.3
# 声ごとのセグメント置き場（この本の制作構成。声の生成方法が変わったらここを直す）
SEG_DIRS = {
    'female': os.path.join(WORK, 'muse-raw'),
    'male': os.path.join(WORK, 'mai-stretched'),
}


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                        '-of', 'csv=p=0', path], capture_output=True, text=True)
    return float(r.stdout.strip())


def plain_len(t):
    return len(re.sub(r'《[^》]*》', '', t.replace('｜', '')))


def app_split(text):
    """logic.ts の splitSentences の再現（ルビ内では割らない）"""
    out = []
    buf = ''
    in_ruby = False
    i = 0
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


def gen_split(text):
    """生成側の文分割（gen_muse.py / gen_mai.py と同じ：---行を除き 。！？ で割る）"""
    text = ''.join(ln for ln in text.split('\n') if ln.strip() != '---')
    parts = re.findall(r'[^。！？]+[。！？]?', text)
    return [p for p in (x.strip() for x in parts) if p]


def fail(msg):
    print('ERROR:', msg)
    sys.exit(1)


def chapter_unit_times(ch, ch_no):
    narrator = ch['narrator']
    seg_dir = SEG_DIRS.get(narrator)
    if not seg_dir:
        fail(f'ch{ch_no}: 未知の narrator {narrator}')
    files = glob.glob(os.path.join(seg_dir, f'ch{ch_no}-*.mp3'))
    files.sort(key=lambda f: int(re.search(r'-(\d+)\.mp3$', f).group(1)))
    if not files:
        fail(f'ch{ch_no}: セグメントが {seg_dir} にない')
    durs = [duration(f) for f in files]

    gen = gen_split(ch['spoken'])
    if len(gen) != len(durs):
        fail(f'ch{ch_no}: 生成文 {len(gen)} 件 ≠ セグメント {len(durs)} 件')

    mp3 = os.path.join(BASE, 'public', 'book', 'audio', f'ch{ch_no}.mp3')
    total_dur = duration(mp3)
    recon = sum(durs) + GAP_SEC * (len(durs) - 1)
    if abs(recon - total_dur) > 0.2:
        fail(f'ch{ch_no}: 再構成尺 {recon:.2f}s が完成MP3 {total_dur:.2f}s と合わない')

    seg_start = []
    acc = 0.0
    for dd in durs:
        seg_start.append(acc)
        acc += dd + GAP_SEC

    # 表示側の単位列（buildUnits と同じ並び。区切りは None）
    disp_paras = ch.get('ruby') or ch['paragraphs']
    disp = []  # True=区切り
    for p in disp_paras:
        if p.strip() == '---':
            disp.append(True)
        else:
            for _ in app_split(p):
                disp.append(False)
    # 読み側の単位列（spoken を段落ごとに対応付け、アプリ規則で割る）
    spoken_lines = ch['spoken'].split('\n')
    sp_units = []  # disp と並行。区切りは None
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
        if li >= len(spoken_lines):
            fail(f'ch{ch_no}: spoken の段落対応が取れない')
        for s in app_split(spoken_lines[li]):
            sp_units.append(s)
        li += 1
    if len(sp_units) != len(disp):
        fail(f'ch{ch_no}: 単位数の不一致 spoken {len(sp_units)} ≠ display {len(disp)}')

    norm = lambda s: re.sub(r'\s+', '', s)
    if norm(''.join(gen)) != norm(''.join(s for s in sp_units if s)):
        fail(f'ch{ch_no}: 生成文とアプリ単位の連結テキストが一致しない')

    # 生成文をアプリ単位へ配分して開始時刻を求める
    real_starts = []
    gi = 0
    g_used = 0.0
    for s in sp_units:
        if s is None:
            continue
        target = len(norm(s))
        start_time = None
        consumed = 0
        while consumed < target:
            g = norm(gen[gi])
            avail = len(g) - g_used
            take = min(avail, target - consumed)
            if start_time is None:
                frac = g_used / len(g) if len(g) else 0.0
                start_time = seg_start[gi] + frac * durs[gi]
            consumed += take
            g_used += take
            if g_used >= len(g):
                gi += 1
                g_used = 0.0
        real_starts.append(start_time)
    if gi != len(gen):
        fail(f'ch{ch_no}: 生成文を配分しきれない ({gi}/{len(gen)})')

    # 区切り単位は「次の文の開始時刻」を持たせる（長さゼロの単位として扱う）
    times = []
    ri = 0
    for is_sep in disp:
        if is_sep:
            times.append(real_starts[ri] if ri < len(real_starts) else total_dur)
        else:
            times.append(real_starts[ri])
            ri += 1
    if any(times[i] > times[i + 1] + 1e-9 for i in range(len(times) - 1)):
        fail(f'ch{ch_no}: unitTimes が単調でない')
    if times and not (0 <= times[0] and real_starts[-1] < total_dur):
        fail(f'ch{ch_no}: unitTimes の範囲が不正')
    return [round(t, 3) for t in times], total_dur


def main():
    src_path = os.path.join(BASE, 'data', 'chapters.json')
    pub_path = os.path.join(BASE, 'public', 'book', 'data.json')
    data = json.load(open(src_path))
    for i, ch in enumerate(data['chapters']):
        times, total = chapter_unit_times(ch, i + 1)
        ch['unitTimes'] = times
        print(f'ch{i + 1}: units={len(times)} duration={total:.2f}s '
              f'first={times[0]:.2f} last={times[-1]:.2f}')
    for path in (src_path, pub_path):
        json.dump(data, open(path, 'w'), ensure_ascii=False, indent=1)
        print('wrote', path)


if __name__ == '__main__':
    main()
