#!/usr/bin/env python3
"""章背景イラストの下帯を切り出す（v1.13.7〜：下帯のみ）。

地絵（生成イラスト）から下の帯だけを切り出し、上端をコサイン・フェードで
紙色へ溶かして public/book/bg/ch{n}-bottom.webp に出す。トップ帯は
v1.13.4 で廃止済み（章タイトル行と絵が重なって「うるさい」という実機指摘）。

下帯の寸法ルール（v1.13.7 で数値化、v1.13.8 で改定。DESIGN.md の本文・
章背景の項と対）:
  - 帯全体の高さはページ高さの最大 23%
  - 絵の本体（線・面のある部分、不透明のまま見える部分）は最下部の 15% 以内
  - 帯の上の部分（本体より上の 8% 分）はフェード専用
    （紙色へ溶けて、本文の行が掛かっても読みにくくならない濃さ）
  - 本文の表示域は下限をページ高さの 85% までとし（src/style.css の
    .page-content）、本体と本文は重ならない。ノンブルだけは例外として
    従来どおり下の帯の中に置く。
  改定理由（v1.13.8）: 22% ルールでは本文の終わりと絵の間に空白の帯が
  でき、ページが空いて見えた（第4章で顕著だったという実機感想）。

実装: 帯画像は alpha=0（切り位置）から alpha=1（本体開始）までコサインで
立ち上げる。モチーフの自然な上端がフェード区間より下にあっても構わない
（フェードはあくまで上限の決まりで、薄い絵はそのまま薄く見える）。

ページ換算: ページの設計寸法は W:H = 600:1300。帯画像は background-size:
100% auto でページ幅に合わせるため、表示される帯の高さ比は
  (帯の高さpx / 帯の幅px) / (1300/600)
で決まる。地絵の H/W が 1300/600 と同じ章（1056x2288）は換算係数 1、
1120x2240 の章は 0.9231 になる。bodyStart / cut は地絵の行比で指定し、
換算後のページ比でルールを満たすよう選ぶ。

地色の統一: 生成イラストの地色（紙の部分）は章ごとに少し違うため、切り出しの
ついでに「地色に近いピクセルだけ」をページの紙色 (250,242,228) へ寄せる
（モチーフの線・面は地色から遠いので触れない）。v1.13.4 の帯で実績のある処理。

使い方: python3 work/split-bg-bands.py
"""
import os

import numpy as np
from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "public/book/bg")
IMAGINE = os.path.expanduser("~/workspace/imagine_media")
YOUR_FILES = os.path.expanduser("~/workspace/your_files")

# ページの設計寸法比（W:H = 600:1300）
PAGE_K = 1300 / 600
# ルールの数値（ページ高さに対する比）
BAND_MAX = 0.23   # 帯全体の上限
BODY_MAX = 0.15   # 本体の上限（最下部から）
FADE = 0.08       # フェード部の幅
# ページの紙色（帯の地色を寄せる先）
PAPER = np.array([250.0, 242.0, 228.0])
# 地色とみなす距離（RGB ユークリッド）。これより近いピクセルほど強く寄せる
GROUND_RANGE = 60.0

# 章ごとの指定: (地絵ファイル, 本体の開始位置＝地絵の行比)
# 本体開始は「その行から下が alpha=1」を意味する。切り位置はフェード幅から
# 自動で決まる（本体開始 − フェード幅の地絵行比換算）。
CHAPTERS = {
    # ch1 は昭和版の作り直し（your_files/ch1-bg-remake）が正。2階と看板・庇は
    # 帯に入れない（v1.13.7 実機指摘：本文の行が2階の窓・庇と重なって読めない）。
    # v1.13.8 では切り位置が 0.770 まで下がり、2階・看板はさらに確実に外れる。
    # テント庇はフェード区間で溶け、店先（引き戸・均一ワゴン・自転車・まる）だけが残る
    1: (os.path.join(YOUR_FILES, "ch1-bg-remake/ch1-bg-showa-bookshop-v2.webp"), 0.850),
    2: (os.path.join(IMAGINE, "media-generation-sora-no-yubin-bg-ch2-umbrella-0-9f0eab9c-bc58-4ee0-9b35-986746a2e331.webp"), 0.850),
    3: (os.path.join(IMAGINE, "media-generation-sora-no-yubin-bg-ch3-reserved-0-f69f7fac-50c9-4975-a60a-ba9f51fa0ece.webp"), 0.850),
    4: (os.path.join(IMAGINE, "media-generation-sora-no-yubin-bg-ch4-homework-0-38488471-4544-4d2a-9671-2a2290d31de1.webp"), 0.890),
    # ch5: 本棚の最下段・カウンター（封筒）・丸座布団が本体。棚の上部はフェードで溶ける
    5: (os.path.join(IMAGINE, "media-generation-sora-no-yubin-bg-ch5-three-mon-0-ee3f2c97-75ff-40c5-8957-fd208d4386fc.webp"), 0.850),
    # ch6: 床と間取り図（巻物）の下部が本体。午後の光の面はフェードで溶ける
    6: (os.path.join(IMAGINE, "media-generation-sora-no-yubin-bg-ch6-empty-sho-0-222be8b8-faa8-4412-8a49-7050d7c2cd7b.webp"), 0.850),
    # ch7: 看板の下端はフェードで溶け、入口と植木が本体。自然な絵の上端
    # （0.76 あたり）はフェード区間の中にあり、そのまま薄く見える
    7: (os.path.join(IMAGINE, "media-generation-sora-no-yubin-bg-ch7-new-shop-0-d8b8d806-a788-41ca-be0d-3a384bda0814.webp"), 0.850),
}


def unify_ground(rgb: np.ndarray) -> np.ndarray:
    """地色に近いピクセルだけをページの紙色へ寄せる。

    地色は本文域（中央の空白、行比 0.30〜0.45）の中央値で推定する。
    """
    h = rgb.shape[0]
    mid = rgb[int(h * 0.30):int(h * 0.45)].reshape(-1, 3)
    ground = np.median(mid, axis=0)
    dist = np.linalg.norm(rgb - ground, axis=2)
    w = np.clip(1.0 - dist / GROUND_RANGE, 0.0, 1.0)[..., None]
    return rgb + (PAPER - ground) * w


def make_band(ch: int, src_path: str, body_start: float) -> None:
    im = Image.open(src_path).convert("RGB")
    w, h = im.size
    # 地絵の行比 → ページ高さ比の換算係数
    conv = (h / w) / PAGE_K
    fade_src = FADE / conv
    cut = body_start - fade_src
    rgb = unify_ground(np.asarray(im).astype(np.float64))
    y0, y1 = int(h * cut), int(h * body_start)
    band = rgb[y0:].copy()
    # alpha: cut で 0 → body_start で 1（コサイン）、それ以下は 1
    ramp = 0.5 * (1 - np.cos(np.pi * np.arange(y1 - y0) / max(1, (y1 - y0))))
    alpha = np.ones(band.shape[0])
    alpha[: y1 - y0] = ramp
    alpha_full = np.broadcast_to(alpha[:, None, None], (band.shape[0], band.shape[1], 1))
    out = np.dstack([band, alpha_full * 255]).astype(np.uint8)
    path = os.path.join(OUT, f"ch{ch}-bottom.webp")
    Image.fromarray(out, "RGBA").save(path, "WEBP", quality=88)
    band_frac = (1 - cut) * conv
    body_frac = (1 - body_start) * conv
    ok = band_frac <= BAND_MAX + 1e-9 and body_frac <= BODY_MAX + 1e-9
    print(
        f"ch{ch}: cut={cut:.3f} bodyStart={body_start:.3f} "
        f"帯={band_frac * 100:.1f}% 本体={body_frac * 100:.1f}% フェード={FADE * 100:.0f}% "
        f"{'OK' if ok else 'NG ルール超過'} {os.path.getsize(path)} bytes"
    )


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for ch, (src, body_start) in CHAPTERS.items():
        make_band(ch, src, body_start)


if __name__ == "__main__":
    main()
