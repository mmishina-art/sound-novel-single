#!/usr/bin/env python3
"""ch7 専用：検証をバッチ分割して実行し、途中結果を都度保存する。
（VM のメモリ逼迫で長時間プロセスが落ちるための分割実行版。
 本体は verify_gemini38_single.py の関数をそのまま使う）"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_gemini38_single as V

CID = 'ch7'
PART = os.path.join(V.WORK, 'verify-ch7-part.json')


def main():
    lo, hi = int(sys.argv[1]), int(sys.argv[2])
    ch = [c for c in V.DATA['chapters'] if c['id'] == CID][0]
    mp3 = os.path.join(V.AUDIO, f'{CID}.mp3')
    sents = V.gen_split(ch['spoken'])
    state = json.load(open(PART)) if os.path.exists(PART) else {}
    audio = V.load_audio(mp3)
    if 'starts' not in state:
        speech_start, speech_end = V.speech_span(mp3)
        s_ends = [e for (s, e) in V.silences(mp3) if speech_start < e < speech_end]
        starts, whole = V.align_starts(audio, sents, speech_start, speech_end,
                                       silence_ends=s_ends)
        state['starts'] = starts
        state['speech_start'] = speech_start
        state['speech_end'] = speech_end
        state['whole'] = V.score(''.join(sents), whole)
        state['results'] = {}
        json.dump(state, open(PART, 'w'), ensure_ascii=False, indent=1)
        print('alignment done; whole kana', state['whole']['kana_ratio'], flush=True)
    starts = state['starts']
    speech_end = state['speech_end']
    dur_total = V.duration(mp3)
    sr = 16000
    for j in range(lo, min(hi, len(sents))):
        if str(j) in state['results']:
            continue
        a = starts[j]
        b = starts[j + 1] if j + 1 < len(starts) else speech_end
        seg = audio[int(max(0.0, a - 0.05) * sr):int(min(dur_total, b + 0.05) * sr)]
        heard = V.transcribe_np(seg)
        sc = V.score(sents[j], heard)
        sc['index'] = j
        sc['start'] = round(a, 2)
        state['results'][str(j)] = sc
        print(f'  seg {j} {sc["flag"]} kana {sc["kana_ratio"]}', flush=True)
        json.dump(state, open(PART, 'w'), ensure_ascii=False, indent=1)
    done = len(state['results'])
    print(f'progress {done}/{len(sents)}', flush=True)
    if done == len(sents):
        res = {'chapter': CID, 'sentences': len(sents),
               'duration': round(dur_total, 2),
               'speech_start': round(state['speech_start'], 3),
               'speech_end': round(speech_end, 3),
               'starts': [round(s, 3) for s in starts],
               'results': [state['results'][str(j)] for j in range(len(sents))],
               'whole': state['whole']}
        ut = V.unit_times(ch, starts, speech_end, dur_total)
        res['unitTimes'] = ut
        res['unit_count'] = len(ut)
        res['expected_unit_count'] = len(ch['unitTimes'])
        tpath = os.path.join(V.AUDIO, f'{CID}-title.mp3')
        res['title'] = V.score(V.CALLS[CID], V.transcribe_np(V.load_audio(tpath)))
        out_path = os.path.join(V.WORK, 'verify-gemini38.json')
        results = json.load(open(out_path)) if os.path.exists(out_path) else {}
        results[CID] = res
        json.dump(results, open(out_path, 'w'), ensure_ascii=False, indent=1)
        ut_path = os.path.join(V.STAGE, 'unitTimes.json')
        utimes = json.load(open(ut_path)) if os.path.exists(ut_path) else {}
        utimes[CID] = ut
        json.dump(utimes, open(ut_path, 'w'), ensure_ascii=False, indent=1)
        ok = sum(1 for r in res['results'] if r['flag'] == 'OK')
        print(f'ch7 COMPLETE: OK {ok}/{len(sents)}, whole kana {res["whole"]["kana_ratio"]}, '
              f'title kana {res["title"]["kana_ratio"]}, units {len(ut)}/{len(ch["unitTimes"])}',
              flush=True)


if __name__ == '__main__':
    main()
