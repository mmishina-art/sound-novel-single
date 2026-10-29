#!/usr/bin/env python3
"""unitTimes の再構築だけを行う（検証済み章の時刻精度の更新用）。

verify_gemini38_single.py のアライン（単語タイムスタンプ＋無音吸着）で
文の開始時刻を求め直し、work/gemini38/unitTimes.json を更新する。
文単位の文字起こし検証は行わない（内容の検証結果は verify 側が正）。
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_gemini38_single as V


def main():
    only = sys.argv[1:] or None
    ut_path = os.path.join(V.STAGE, 'unitTimes.json')
    utimes = json.load(open(ut_path)) if os.path.exists(ut_path) else {}
    res_path = os.path.join(V.WORK, 'verify-gemini38.json')
    results = json.load(open(res_path)) if os.path.exists(res_path) else {}
    for ch in V.DATA['chapters']:
        cid = ch['id']
        if only and cid not in only:
            continue
        mp3 = os.path.join(V.AUDIO, f'{cid}.mp3')
        if not os.path.exists(mp3):
            print(f'{cid}: staging mp3 missing, skip')
            continue
        sents = V.gen_split(ch['spoken'])
        audio = V.load_audio(mp3)
        speech_start, speech_end = V.speech_span(mp3)
        s_ends = [e for (s, e) in V.silences(mp3) if speech_start < e < speech_end]
        starts, _whole = V.align_starts(audio, sents, speech_start, speech_end,
                                        silence_ends=s_ends)
        ut = V.unit_times(ch, starts, speech_end, V.duration(mp3))
        utimes[cid] = ut
        if cid in results:
            results[cid]['starts'] = [round(s, 3) for s in starts]
            results[cid]['unitTimes'] = ut
        print(f'{cid}: units {len(ut)}/{len(ch["unitTimes"])} rebuilt', flush=True)
        json.dump(utimes, open(ut_path, 'w'), ensure_ascii=False, indent=1)
        json.dump(results, open(res_path, 'w'), ensure_ascii=False, indent=1)
    print('unitTimes ->', ut_path)


if __name__ == '__main__':
    main()
