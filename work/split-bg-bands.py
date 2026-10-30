# 章背景（生成イラスト）を上下の帯に切り分ける（v1.13.3〜）。
# 使い方: python3 work/split-bg-bands.py <imagine_media のディレクトリ>
# 出力: public/book/bg/ch{n}-top.webp / ch{n}-bottom.webp
# 方針: モチーフは上下の端にしか無い（ゾーンルール）ので、真ん中の無地は捨てる。
# 切り位置は章ごとに、インク行の計測（95パーセンタイル）＋目視補正で決めた表 CUTS に従う。
# 切り口は余白帯の中でアルファをコサイン減衰させ、紙の上で継ぎ目が見えないようにする。
import sys, os
from PIL import Image
import numpy as np

SRC = {
 1:'media-generation-sora-no-yubin-bg-ch1-sample-0-bb2508c9-dd09-4667-8651-f531e7e61d20.webp',
 2:'media-generation-sora-no-yubin-bg-ch2-umbrella-0-9f0eab9c-bc58-4ee0-9b35-986746a2e331.webp',
 3:'media-generation-sora-no-yubin-bg-ch3-reserved-0-f69f7fac-50c9-4975-a60a-ba9f51fa0ece.webp',
 4:'media-generation-sora-no-yubin-bg-ch4-homework-0-38488471-4544-4d2a-9671-2a2290d31de1.webp',
 5:'media-generation-sora-no-yubin-bg-ch5-three-mon-0-ee3f2c97-75ff-40c5-8957-fd208d4386fc.webp',
 6:'media-generation-sora-no-yubin-bg-ch6-empty-sho-0-222be8b8-faa8-4412-8a49-7050d7c2cd7b.webp',
 7:'media-generation-sora-no-yubin-bg-ch7-new-shop-0-d8b8d806-a788-41ca-be0d-3a384bda0814.webp',
}
# (上モチーフの下端, 上帯の切り位置, 下モチーフの上端, 下帯の切り位置) いずれも高さ比
CUTS = {
 1:(0.120, 0.185, 0.826, 0.761),
 2:(0.062, 0.127, 0.795, 0.730),
 3:(0.066, 0.131, 0.828, 0.763),
 4:(0.045, 0.110, 0.890, 0.825),
 5:(0.109, 0.174, 0.545, 0.480),
 6:(0.070, 0.135, 0.645, 0.580),
 7:(0.100, 0.165, 0.744, 0.679),
}

def main(src_dir: str) -> None:
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'public', 'book', 'bg')
    total = 0
    for n, name in SRC.items():
        im = Image.open(os.path.join(src_dir, name)).convert('RGB')
        W, H = im.size
        tie, tc, bis, bc = CUTS[n]
        # 上帯: 0..topCut。フェードは inkEnd+1% 〜 topCut
        top = im.crop((0, 0, W, int(H * tc))).convert('RGBA')
        a = np.asarray(top).copy()
        ys = np.arange(a.shape[0]) / H
        ramp = np.ones(a.shape[0], dtype=np.float32)
        m = ys > tie + 0.01
        t = np.clip((ys[m] - (tie + 0.01)) / (tc - (tie + 0.01)), 0, 1)
        ramp[m] = 0.5 * (1 + np.cos(np.pi * t))
        a[..., 3] = (a[..., 3] * ramp[:, None]).astype(np.uint8)
        Image.fromarray(a).save(os.path.join(out_dir, f'ch{n}-top.webp'),
                                quality=85, alpha_quality=100, method=6)
        # 下帯: botCut..H。フェードは botCut 〜 inkStart-1%
        y0 = int(H * bc)
        bot = im.crop((0, y0, W, H)).convert('RGBA')
        b = np.asarray(bot).copy()
        ys = (np.arange(b.shape[0]) + y0) / H
        ramp = np.ones(b.shape[0], dtype=np.float32)
        m = ys < bis - 0.01
        t = np.clip((ys[m] - bc) / ((bis - 0.01) - bc), 0, 1)
        ramp[m] = 0.5 * (1 - np.cos(np.pi * t))
        b[..., 3] = (b[..., 3] * ramp[:, None]).astype(np.uint8)
        Image.fromarray(b).save(os.path.join(out_dir, f'ch{n}-bottom.webp'),
                                quality=85, alpha_quality=100, method=6)
        for part in ('top', 'bottom'):
            s = os.path.getsize(os.path.join(out_dir, f'ch{n}-{part}.webp'))
            total += s
            print(f'ch{n}-{part}.webp {s} bytes')
    print('TOTAL', total, 'bytes')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/workspace/imagine_media'))
