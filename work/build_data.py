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

data = {
    'title': '空の郵便が届くまで',
    'author': '水瀬 葵',
    'totalChars': total,
    'chapters': chapters,
}
json.dump(data, open(os.path.join(ROOT, 'data', 'chapters.json'), 'w'), ensure_ascii=False, indent=1)
print('chapters:', len(chapters), 'total chars:', total)
for ch in chapters:
    print(ch['id'], ch['title'], ch['narrator'], ch['chars'], 'spoken', ch['spokenChars'])
