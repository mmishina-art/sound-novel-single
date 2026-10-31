#!/usr/bin/env python3
"""原稿Markdownから chapters.json を生成する。
- ruby: 読み辞書（WORDS最長一致）＋単漢字（NOUN1/VERB）で青空式ルビ記法を付与
- spoken: WORDSをかな化した読み上げ文（固有名詞・多読語を固定）
"""
import json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'data'))
from readings import WORDS, SINGLE
WORDS = {**WORDS, **{k: v for k, v in SINGLE.items() if k not in WORDS}}
from stems import NOUN1, VERB

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
md = open(os.path.join(ROOT, 'manuscript', 'story.md')).read()

chapters = []
for m in re.finditer(r'## (第[一二三四五六七]章)　(.+?)（(.+?)）\n(.*?)(?=\n## |\Z)', md, re.S):
    num, title, narrator_name, body = m.groups()
    paras = [p.replace('\n', '') for p in body.strip().split('\n\n') if p.strip()]
    chapters.append({
        'num': num, 'title': title, 'narratorName': narrator_name,
        'narrator': 'female' if narrator_name.endswith('遥') else 'male',
        'paragraphs': paras,
    })

KEYS = sorted(WORDS.keys(), key=len, reverse=True)
KANJI = re.compile(r'[一-龥々]')

def annotate(text):
    """表示用ルビ記法テキストを返す"""
    out = []
    i = 0
    while i < len(text):
        matched = None
        for k in KEYS:
            if text.startswith(k, i):
                matched = k
                break
        if matched:
            out.append(f'｜{matched}《{WORDS[matched]}》')
            i += len(matched)
            continue
        ch = text[i]
        if KANJI.match(ch):
            nxt = text[i+1] if i + 1 < len(text) else ''
            if ch in VERB:
                stem, full = VERB[ch]
                if nxt and re.match(r'[ぁ-ん]', nxt):
                    out.append(f'｜{ch}《{stem}》')
                else:
                    out.append(f'｜{ch}《{full}》')
                i += 1
                continue
            if ch in NOUN1:
                out.append(f'｜{ch}《{NOUN1[ch]}》')
                i += 1
                continue
        out.append(ch)
        i += 1
    return ''.join(out)

def to_spoken(text):
    """読み上げ文：辞書語をかなに置換"""
    out = []
    i = 0
    while i < len(text):
        matched = None
        for k in KEYS:
            if text.startswith(k, i):
                matched = k
                break
        if matched:
            out.append(WORDS[matched])
            i += len(matched)
            continue
        out.append(text[i])
        i += 1
    s = ''.join(out)
    s = s.replace('私', 'わたし')  # 一人称は文脈上つねに「わたし」
    return s

total = 0
for idx, ch in enumerate(chapters, 1):
    ch['id'] = f'ch{idx}'
    ch['ruby'] = [annotate(p) for p in ch['paragraphs']]
    ch['spoken'] = '\n'.join(to_spoken(p) for p in ch['paragraphs'])
    ch['chars'] = sum(len(p) for p in ch['paragraphs'])
    ch['spokenChars'] = len(ch['spoken'].replace('\n', ''))
    total += ch['chars']

# 音声の実容量（バイト）：初回ダウンロード案内（アプリが総容量を表示する）の
# 材料。配信コピー public/book/audio の実ファイルを測る。音声がまだ無い章は
# 項目ごと省く（アプリ側は「全章そろっているときだけ総容量を出す」前提）。
_audio_dir = os.path.join(ROOT, 'public', 'book', 'audio')
_total_audio = 0
_audio_complete = True
for ch in chapters:
    sizes = []
    for name in (f"{ch['id']}.mp3", f"{ch['id']}-title.mp3"):
        p = os.path.join(_audio_dir, name)
        if not os.path.exists(p):
            sizes = None
            break
        sizes.append(os.path.getsize(p))
    if sizes is None:
        _audio_complete = False
    else:
        ch['audioBytes'] = sum(sizes)
        _total_audio += ch['audioBytes']

# unitTimes（文ごとの実開始時刻）は音声由来のデータで、このスクリプトでは作らない。
# 原稿（paragraphs と spoken）が前回と変わっていない章は、前回の値を引き継ぐ。
# 変わった章は落ちるので、そのときは work/build_timings.py を実行し直すこと。
_prev_path = os.path.join(ROOT, 'data', 'chapters.json')
if os.path.exists(_prev_path):
    _prev = {c.get('id'): c for c in json.load(open(_prev_path)).get('chapters', [])}
    for ch in chapters:
        old = _prev.get(ch['id'])
        if (old and old.get('unitTimes') and old.get('paragraphs') == ch['paragraphs']
                and old.get('spoken') == ch['spoken']):
            ch['unitTimes'] = old['unitTimes']

data = {
    'title': '空の郵便が届くまで',
    'author': '桜井 みゅう',
    # 本ごとの方向設定：'vertical'＝縦書き・右綴じ（既定）／'horizontal'＝横書き・左綴じ（アプリ側は将来対応）
    'direction': 'vertical',
    # 本ごとの基調色（テーマカラー）：表紙ページの机の地と読書灯の光の色味の元になる色。
    # 表紙の絵と対になる色を1色だけ指定し、濃淡はアプリ側（CSS）がこの色から作る（v1.13.15〜）
    'themeColor': '#1e2d52',
    'totalChars': total,
    'chapters': chapters,
}
if _audio_complete:
    data['totalAudioBytes'] = _total_audio
json.dump(data, open(os.path.join(ROOT, 'data', 'chapters.json'), 'w'), ensure_ascii=False, indent=1)
# アプリ（pwa-template 構成）の配信データは public/book/data.json（data/chapters.json と同一内容）
_pub = os.path.join(ROOT, 'public', 'book', 'data.json')
os.makedirs(os.path.dirname(_pub), exist_ok=True)
json.dump(data, open(_pub, 'w'), ensure_ascii=False, indent=1)
print('chapters:', len(chapters), 'total chars:', total)
for ch in chapters:
    print(ch['id'], ch['title'], ch['narrator'], ch['chars'], 'spoken', ch['spokenChars'])
