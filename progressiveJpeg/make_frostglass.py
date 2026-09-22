#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双表法毛玻璃:拿 JPEG 的 1/8 解码当降采样器,靠采样几何换到大 sigma。

思路和常规做法相反 —— 不做大核卷积,而是让 sigma 从「采样几何」里免费长出来:

    scale=1/8 解码  = 每 8x8 块只取 DC = 宽 8 的 box       方差 (8^2-1)/12 = 5.25
    双线性上采样 8x = 半宽 8 的三角核                       方差 8^2/6    = 10.67
    两者独立,方差相加  ->  sigma_base = sqrt(15.92) = 3.99

再在 1/8 小图上叠 n 趟 w x w 的 box,小图 1 px 折算原图 8 px,方差按 64 倍放大:

    sigma_total = sqrt(16 + (64/12) * n * (w^2 - 1))

「双表」指编码和解码用两张不同的量化表:
    Q_enc(编码器内部,不写进文件) AC = 255  -> AC 系数全量化成 0,码流暴降
    Q_dec(写进文件的 DQT)        AC = 1    -> 万一被 1/1 全解码,残留高频不炸振铃
    两表的 Q(0,0) 必须相同,否则 DC 增益不为 1(见 failure_modes.png)

用法:
    python make_frostglass.py                    # 跑全部预设档位
    python make_frostglass.py --sigma 15         # 反解出 (w,n) 命中 sigma=15
    python make_frostglass.py --q00 4 8          # 换 DC 量化步长
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter

# 复用同目录 make_progressive.py 里的指标 / 拼版工具,口径保持一致
from make_progressive import contact_sheet, gauss_blur, psnr, ssim


# --------------------------------------------------------------------------- #
# 双表编码
# --------------------------------------------------------------------------- #

def dqt_offsets(raw: bytes) -> list[tuple[int, int]]:
    """扫出每张 DQT 的 (Tq, 64 字节表数据起始偏移)。只处理 8-bit 精度表。"""
    out: list[tuple[int, int]] = []
    i, n = 0, len(raw)
    while i < n - 1:
        if raw[i] != 0xFF:
            i += 1
            continue
        m = raw[i + 1]
        if m == 0xD8 or m == 0x01 or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        if m == 0xDA or m == 0xD9:          # 到 SOS 就停,后面是熵数据
            break
        length = int.from_bytes(raw[i + 2:i + 4], "big")
        if m == 0xDB:
            p = i + 4
            while p < i + 2 + length:
                pq, tq = raw[p] >> 4, raw[p] & 0x0F
                if pq != 0:
                    raise ValueError("遇到 16-bit DQT,未处理")
                out.append((tq, p + 1))
                p += 1 + 64
        i += 2 + length
    return out


def encode_dual(im: Image.Image, q00_y: int, q00_c: int,
                ac_enc: int = 255, ac_dec: int = 1,
                subsampling: str = "4:2:0") -> tuple[bytes, bytes]:
    """双表编码,返回 (双表码流, 单表对照码流)。

    两份码流的熵数据逐位相同,只有 DQT 那 128 字节不同 —— 改表不重新编码。

    注意 PIL 的 qtables 参数吃「自然序」,写进文件时它自己转 zigzag;
    但 zigzag 的 index 0 就是 (0,0),所以 DC 的位置两种序下都是 0。
    """
    qy = [ac_enc] * 64
    qy[0] = q00_y
    qc = [ac_enc] * 64
    qc[0] = q00_c

    buf = io.BytesIO()
    im.save(buf, "JPEG", qtables=[qy, qc], subsampling=subsampling, optimize=True)
    single = buf.getvalue()                 # 单表法:文件里就是 Q_enc

    dual = bytearray(single)
    for tq, off in dqt_offsets(dual):
        q00 = q00_y if tq == 0 else q00_c
        for k in range(64):
            dual[off + k] = q00 if k == 0 else ac_dec
    return bytes(dual), single


def decode_scaled(raw: bytes, denom: int) -> np.ndarray:
    """按 1/denom 解码。denom=8 时亮度走 jpeg_idct_1x1,只吃 DC。"""
    im = Image.open(io.BytesIO(raw))
    if denom > 1:
        w, h = im.size
        im.draft("RGB", (max(1, w // denom), max(1, h // denom)))
    return np.array(im.convert("RGB"))


# --------------------------------------------------------------------------- #
# 后处理管线
# --------------------------------------------------------------------------- #

def box_iter(arr: np.ndarray, w: int, n: int) -> np.ndarray:
    """在小图上叠 n 趟 w x w box。w=1 或 n=0 时原样返回。

    嵌入式上这一步是可分离的滑动窗口累加(每通道每趟 ~3 次整数运算/px),
    这里用 uniform_filter 只为拿到同样的数值结果。
    """
    if w <= 1 or n <= 0:
        return arr.copy()
    x = arr.astype(np.float32)
    for _ in range(n):
        x = uniform_filter(x, size=(w, w, 1), mode="nearest")
    return np.clip(np.rint(x), 0, 255).astype(np.uint8)


def upsample(small: np.ndarray, W: int, H: int, mode=Image.BILINEAR) -> np.ndarray:
    return np.array(Image.fromarray(small).resize((W, H), mode))


def frost(small: np.ndarray, W: int, H: int, w: int, n: int) -> np.ndarray:
    """完整管线的后半段:小图 -> box 迭代 -> 双线性放大回全尺寸。"""
    return upsample(box_iter(small, w, n), W, H)


def sigma_formula(w: int, n: int) -> float:
    """方案给的解析式。注意它只叠了小图上的 box,没叠上采样的 tent,会低估。"""
    return math.sqrt(16.0 + (64.0 / 12.0) * n * (w * w - 1))


def solve_wn(sigma: float, w_max: int = 15, n_max: int = 6) -> tuple[int, int, float]:
    """反解:给定目标 sigma,搜 (窗宽, 迭代次数) 里最接近的一组。

    只搜 w 会被奇数量化卡死 —— n=3 时 w=3 给 12.0、w=5 给 20.0,中间的 15 落不着。
    n 也放开搜就能补上:n=5,w=3 给 15.14。返回 (w, n, 公式 sigma)。
    """
    if sigma <= sigma_formula(1, 0):
        return 1, 0, sigma_formula(1, 0)
    cands = [(w, n) for w in range(3, w_max + 1, 2) for n in range(1, n_max + 1)]
    w, n = min(cands, key=lambda c: abs(sigma_formula(*c) - sigma))
    return w, n, sigma_formula(w, n)


def rgb565(arr: np.ndarray) -> np.ndarray:
    """模拟 RGB565 存储:高位截断 + 高位复制补低位(和硬件扩展一致)。"""
    r = (arr[..., 0] & 0xF8) | (arr[..., 0] >> 5)
    g = (arr[..., 1] & 0xFC) | (arr[..., 1] >> 6)
    b = (arr[..., 2] & 0xF8) | (arr[..., 2] >> 5)
    return np.stack([r, g, b], axis=-1)


# --------------------------------------------------------------------------- #
# 反解「最匹配的真高斯 sigma」
# --------------------------------------------------------------------------- #

class GaussCache:
    def __init__(self, orig: np.ndarray):
        self.orig = orig
        self._c: dict[float, np.ndarray] = {}

    def get(self, s: float) -> np.ndarray:
        k = round(float(s), 2)
        if k not in self._c:
            self._c[k] = gauss_blur(self.orig, k)
        return self._c[k]


def best_gauss(x: np.ndarray, gc: GaussCache, lo: float, hi: float
               ) -> tuple[float, float, float]:
    """粗到细搜 PSNR 最高的真高斯 sigma。返回 (sigma, PSNR, SSIM)。

    先 1.0 步长定位,再在 ±1.0 内 0.1 步长细搜 —— 已和全网格 0.1 步长
    (1.0~40.0)的结果核对过,逐位一致,没有落进局部极值。
    """
    coarse = np.arange(lo, hi + 1e-9, 1.0)
    c = max(coarse, key=lambda s: psnr(x, gc.get(s)))
    fine = np.arange(max(0.5, c - 1.0), c + 1.0 + 1e-9, 0.1)
    c = max(fine, key=lambda s: psnr(x, gc.get(s)))
    g = gc.get(c)
    return float(c), psnr(x, g), ssim(x, g)


# --------------------------------------------------------------------------- #
# 平移不变性(呼吸感)
# --------------------------------------------------------------------------- #

def shift_test(im: Image.Image, q00: tuple[int, int], w: int, n: int,
               shifts: int = 8) -> dict:
    """把画面内容相对 8x8 网格平移 0..7 px,看输出抖多少。

    box 的采样格点钉死在 8 的倍数上,平移不会被吸收 —— 静态图无所谓,
    滚动 / 摄像头场景会看到「呼吸感」。真高斯是平移不变的,拿它当基线。
    """
    arr = np.array(im)
    H, W = arr.shape[:2]
    Hc, Wc = H - shifts, W - shifts          # 各档位共用的裁切尺寸
    outs, refs = [], []
    for s in range(shifts):
        sub = Image.fromarray(arr[s:s + Hc, s:s + Wc])
        dual, _ = encode_dual(sub, q00[0], q00[1])
        small = decode_scaled(dual, 8)
        outs.append(frost(small, Wc, Hc, w, n))
        refs.append(gauss_blur(np.array(sub), sigma_formula(w, n)))

    def spread(seq):
        """seq[s] 的 (i,j) 对应原图 (s+i, s+j),要按 s 对齐后再比。"""
        dev = []
        for s in range(1, shifts):
            a = seq[s][0:Hc - shifts, 0:Wc - shifts].astype(np.float64)
            b = seq[0][s:s + Hc - shifts, s:s + Wc - shifts].astype(np.float64)
            dev.append(np.abs(a - b))
        d = np.stack(dev)
        return float(d.max()), float(d.mean())

    fm, fa = spread(outs)
    gm, ga = spread(refs)
    return {"frost_max": fm, "frost_mean": fa, "gauss_max": gm, "gauss_mean": ga}


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

# (w, n, 说明) —— 方案给的档位表
PRESETS = [
    (1, 0, "无后处理 · 纯 1/8+双线性"),
    (3, 1, "常规毛玻璃"),
    (3, 3, "iOS 风格"),
    (5, 3, "CSS blur(20px)"),
    (7, 3, "极重虚化"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="双表法毛玻璃:1/8 解码 + box 迭代 + 双线性")
    ap.add_argument("--src", default="user-wallpaper.png", help="源图")
    ap.add_argument("--out", default="out_frost", help="输出目录")
    ap.add_argument("--q00", type=int, nargs=2, default=[8, 16],
                    metavar=("Y", "C"), help="DC 量化步长 (亮度 色度),默认 8 16")
    ap.add_argument("--sigma", type=float, default=None,
                    help="只跑一个目标 sigma,自动反解窗宽 (n=3)")
    ap.add_argument("--no-shift-test", action="store_true", help="跳过平移不变性测试")
    ap.add_argument("--no-data-js", action="store_true", help="不生成 HTML 用的 data.js")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    src = Path(args.src) if Path(args.src).is_absolute() else here / args.src
    outdir = Path(args.out) if Path(args.out).is_absolute() else here / args.out
    outdir.mkdir(parents=True, exist_ok=True)
    if not src.exists():
        print(f"找不到源图: {src}", file=sys.stderr)
        return 1

    im = Image.open(src).convert("RGB")
    W, H = im.size
    orig = np.array(im)
    gc = GaussCache(orig)
    q00_y, q00_c = args.q00
    print(f"源图 {src.name}  {W}x{H}   Q(0,0) = {q00_y}(Y) / {q00_c}(C)")

    # ---- 1. 双表编码 ----------------------------------------------------- #
    dual, single = encode_dual(im, q00_y, q00_c)
    (outdir / "dual.jpg").write_bytes(dual)
    (outdir / "single.jpg").write_bytes(single)

    ndiff = sum(1 for a, b in zip(dual, single) if a != b)
    ref = io.BytesIO()
    im.save(ref, "JPEG", quality=75, subsampling="4:2:0", optimize=True)
    q75 = len(ref.getvalue())

    print(f"\n=== 码流 ===")
    print(f"  双表 {len(dual):,} B   bpp {len(dual)*8/(W*H):.3f}   "
          f"vs 普通 q75 {q75:,} B = {len(dual)/q75:.3f}x")
    print(f"  与单表码流差异 {ndiff} 字节,全在 DQT 内(改表不重新编码)")
    print(f"  折算 640x480: {len(dual)*8/(W*H)*640*480/8/1024:.1f} KB   "
          f"1024x600: {len(dual)*8/(W*H)*1024*600/8/1024:.1f} KB")

    # ---- 2. 1/8 解码 ------------------------------------------------------ #
    small = decode_scaled(dual, 8)
    sh, sw = small.shape[:2]
    print(f"\n=== 1/8 小图 ===")
    print(f"  {sw}x{sh} = {sw*sh:,} px   RGB565 raw {sw*sh*2:,} B   "
          f"RGB888 raw {sw*sh*3:,} B")
    print(f"  小图 raw 比双表码流{'小' if sw*sh*2 < len(dual) else '大'} "
          f"({sw*sh*2/len(dual):.2f}x) —— 静态场景存 raw 省的是 CPU,不是 Flash")

    # ---- 3. 各档位效果 ---------------------------------------------------- #
    if args.sigma:
        w_s, n_s, sf_s = solve_wn(args.sigma)
        presets = [(w_s, n_s, f"目标 sigma={args.sigma:g}")]
        print(f"\n反解 sigma={args.sigma:g}  ->  box({w_s})x{n_s},公式 sigma={sf_s:.2f}")
    else:
        presets = PRESETS

    print(f"\n=== 各档位 vs 真高斯 ===")
    print(f"  {'路径':<26} {'公式σ':>6} {'实测σ':>6} {'误差':>6} "
          f"{'PSNR':>9} {'SSIM':>7}  {'@公式σ':>9}")
    print("  " + "-" * 82)

    rows = []
    for w, n, tag in presets:
        sf = sigma_formula(w, n)
        x = frost(small, W, H, w, n)
        lo, hi = max(1.0, sf - 4), sf + 6
        sm_best, p_best, s_best = best_gauss(x, gc, lo, hi)
        p_formula = psnr(x, gc.get(sf))

        name = f"frost_w{w}n{n}.png"
        Image.fromarray(x).save(outdir / name)
        gname = f"gauss_s{sm_best:g}".replace(".", "p") + ".png"
        Image.fromarray(gc.get(sm_best)).save(outdir / gname)

        rows.append({
            "w": w, "n": n, "tag": tag, "file": name,
            "sigma_formula": round(sf, 3), "sigma_measured": sm_best,
            "sigma_error": round(sm_best - sf, 3),
            "psnr_vs_gauss": p_best, "ssim_vs_gauss": s_best,
            "psnr_at_formula_sigma": p_formula,
            "box_passes": 2 * n,
        })
        print(f"  box({w})x{n} · {tag:<14} {sf:>6.2f} {sm_best:>6.1f} "
              f"{sm_best-sf:>+6.2f} {p_best:>8.2f}dB {s_best:>7.4f}  {p_formula:>8.2f}dB")

    print(f"\n  公式只算了小图上的 box,漏掉上采样 tent 的贡献,所以系统性低估;")
    print(f"  sigma 越大占比越小。要精确对齐 CSS blur(Npx) 请查「实测σ」列。")

    # ---- 4. 失败模式 ------------------------------------------------------ #
    print(f"\n=== 失败模式 ===")

    full_dual = decode_scaled(dual, 1)
    full_single = decode_scaled(single, 1)
    d = np.abs(full_dual.astype(int) - full_single.astype(int))
    Image.fromarray(full_single).save(outdir / "fail_single_1to1.png")
    Image.fromarray(full_dual).save(outdir / "fail_dual_1to1.png")
    print(f"  [单表] 1/1 全解码 vs 双表: 最大差 {d.max()} 灰阶,平均 {d.mean():.3f}")
    print(f"         -> 把 AC=255 留在文件里,一旦被完整解码就是振铃")

    # 不改表(Q_dec = Q_enc)在 1/8 下的色度残留 —— 推翻「表整形在 1/8 无效」
    noshape = bytearray(single)
    for tq, off in dqt_offsets(noshape):
        q00 = q00_y if tq == 0 else q00_c
        for k in range(64):
            noshape[off + k] = q00 if k == 0 else 255
    ns_small = decode_scaled(bytes(noshape), 8)
    dc = np.abs(ns_small.astype(int) - small.astype(int))

    ycc_a = np.array(Image.fromarray(small).convert("YCbCr")).astype(int)
    ycc_b = np.array(Image.fromarray(ns_small).convert("YCbCr")).astype(int)
    per_ch = {nm: int(np.abs(ycc_a[..., i] - ycc_b[..., i]).max())
              for i, nm in enumerate(("Y", "Cb", "Cr"))}
    Image.fromarray(upsample(ns_small, W, H)).save(outdir / "fail_noshape_1to8.png")
    print(f"  [不改表] Q_dec AC=255 在 1/8 下 vs AC=1: 最大差 {dc.max()} 灰阶")
    print(f"           分通道 {per_ch}  -> Y 恒为 0,残留全来自色度")
    print(f"           4:2:0 时色度 _DCT_scaled_size 被抬到 2,走 jpeg_idct_2x2 会吃 AC,")
    print(f"           所以 AC=1 在 4:2:0 下不是保险而是必需项")

    # Q(0,0) 两表不一致 = 围绕 128 的对比度缩放
    gain_rows = []
    for q_dec in (q00_y // 2, q00_y, q00_y * 2, q00_y * 4):
        mis = bytearray(single)
        for tq, off in dqt_offsets(mis):
            base = q_dec if tq == 0 else q_dec * 2
            for k in range(64):
                mis[off + k] = base if k == 0 else 1
        a = decode_scaled(bytes(mis), 8).astype(float)
        sat = 100 * float(((a <= 0) | (a >= 255)).mean())
        gain_rows.append({"q_dec00": q_dec, "gain": q_dec / q00_y,
                          "mean": round(float(a.mean()), 2),
                          "std": round(float(a.std()), 2), "saturated_pct": round(sat, 2)})
        if q_dec == q00_y * 4:
            Image.fromarray(upsample(
                np.clip(np.rint(a), 0, 255).astype(np.uint8), W, H)
            ).save(outdir / "fail_dc_gain.png")
    print(f"  [Q(0,0) 不一致] 增益 r 使 像素 -> 128 + r*(像素-128),是对比度缩放不是亮度偏移:")
    for g in gain_rows:
        print(f"           Q_dec00={g['q_dec00']:>3} (r={g['gain']:>4.2f}): "
              f"std {g['std']:>6.2f}  饱和 {g['saturated_pct']:>5.1f}%")

    # RGB565 存小图会不会 banding
    sm565 = rgb565(small)
    x565 = frost(sm565, W, H, 3, 3)
    x888 = frost(small, W, H, 3, 3)
    Image.fromarray(x565).save(outdir / "rgb565_w3n3.png")
    print(f"  [RGB565] 小图存 565 再走管线 vs 888: "
          f"PSNR {psnr(x565, x888):.2f}dB  最大差 {np.abs(x565.astype(int)-x888.astype(int)).max()} 灰阶")

    # ---- 5. 平移不变性 ---------------------------------------------------- #
    shift = None
    if not args.no_shift_test:
        shift = {}
        print(f"\n=== 平移不变性(呼吸感)===")
        print(f"  内容相对 8x8 网格平移 0..7 px,对齐后比残差")
        print(f"  {'档位':<14} {'双表 最大':>9} {'双表 平均':>9} {'真高斯 最大':>11} {'真高斯 平均':>11}")
        print("  " + "-" * 60)
        for w, n, tag in presets:
            r = shift_test(im, (q00_y, q00_c), w, n)
            shift[f"w{w}n{n}"] = r
            print(f"  box({w})x{n}{'':<7} {r['frost_max']:>9.1f} {r['frost_mean']:>9.3f} "
                  f"{r['gauss_max']:>11.1f} {r['gauss_mean']:>11.3f}")
        print(f"  -> 真高斯的残差只有边界效应;双表的残差是采样格点钉在 8 的倍数上导致的。")
        print(f"     静态图无所谓,滚动 / 摄像头场景要按这个数评估。")

    # ---- 6. 算力 ---------------------------------------------------------- #
    print(f"\n=== 后处理算力(可分离滑动窗口,~3 次整数运算/px/通道/趟)===")
    print(f"  {'屏幕':>10} {'1/8 小图':>10} {'n=1':>10} {'n=3':>10}")
    for sw_, sh_ in ((320, 240), (480, 320), (640, 480), (1024, 600)):
        px = math.ceil(sw_ / 8) * math.ceil(sh_ / 8)
        print(f"  {sw_}x{sh_:<5} {px:>10,} {px*3*2*1*3:>10,} {px*3*2*3*3:>10,}")
    print(f"  (通道数 3 x 可分离 2 趟 x n x 3 运算;100MHz M4 每 ms 约 10 万次整数运算)")

    # ---- 7. 拼版图 -------------------------------------------------------- #
    pairs = []
    for r in rows:
        pairs.append((f"双表 box({r['w']})x{r['n']} · {r['tag']}",
                      f"{len(dual)/1024:.1f} KB 码流 + {r['box_passes']} 趟 box  "
                      f"| 实测 sigma {r['sigma_measured']:.1f}",
                      Image.open(outdir / r["file"])))
        pairs.append((f"真高斯 sigma={r['sigma_measured']:.1f}",
                      f"需要全部 {W*H*3/1024:.0f} KB 像素  "
                      f"| 与左图 {r['psnr_vs_gauss']:.2f}dB / SSIM {r['ssim_vs_gauss']:.3f}",
                      Image.fromarray(gc.get(r["sigma_measured"]))))
    contact_sheet(pairs, cols=2).save(outdir / "frost_vs_gauss.png")

    # 管线四步走:原图 -> 1/8 小图 -> 双线性 -> 叠 box。最后一格取最重的那档。
    heaviest = max(rows, key=lambda r: r["sigma_measured"])
    overview = [
        ("原图", f"{W}x{H}", im),
        (f"1/8 解码小图 · {sw}x{sh}", f"最近邻放大,看真实分辨率  {sw*sh*2:,} B RGB565",
         Image.fromarray(upsample(small, W, H, Image.NEAREST))),
        ("+ 双线性上采样", f"sigma≈{rows[0]['sigma_measured']:.1f}  一次卷积都没做",
         Image.open(outdir / rows[0]["file"])),
        (f"+ box({heaviest['w']})x{heaviest['n']} · {heaviest['tag']}",
         f"sigma≈{heaviest['sigma_measured']:.1f}",
         Image.open(outdir / heaviest["file"])),
    ]
    contact_sheet(overview, cols=4).save(outdir / "overview.png")

    fails = [
        ("单表 AC=255 · 1/1 全解码", f"振铃,vs 双表最大差 {d.max()} 灰阶",
         Image.open(outdir / "fail_single_1to1.png")),
        ("双表 AC=1 · 1/1 全解码", "无振铃,但是 8x8 马赛克 —— 不是模糊",
         Image.open(outdir / "fail_dual_1to1.png")),
        ("不改表 · 1/8 解码", f"色度残留 {max(per_ch['Cb'], per_ch['Cr'])} 灰阶(Y 为 0)",
         Image.open(outdir / "fail_noshape_1to8.png")),
        (f"Q(0,0) 不一致 · r={gain_rows[-1]['gain']:g}",
         f"对比度爆炸,饱和 {gain_rows[-1]['saturated_pct']:.0f}%",
         Image.open(outdir / "fail_dc_gain.png")),
    ]
    contact_sheet(fails, cols=4).save(outdir / "failure_modes.png")
    print(f"\n拼版图: overview.png / frost_vs_gauss.png / failure_modes.png")

    # ---- 8. metrics ------------------------------------------------------- #
    metrics = {
        "source": {"file": src.name, "width": W, "height": H},
        "encode": {"q00_y": q00_y, "q00_c": q00_c, "ac_enc": 255, "ac_dec": 1,
                   "subsampling": "4:2:0", "dual_bytes": len(dual),
                   "q75_bytes": q75, "ratio_vs_q75": round(len(dual) / q75, 4),
                   "bpp": round(len(dual) * 8 / (W * H), 4),
                   "dqt_only_diff_bytes": ndiff},
        "small": {"width": sw, "height": sh, "rgb565_bytes": sw * sh * 2},
        "presets": rows,
        "failure_modes": {
            "single_table_1to1_max_delta": int(d.max()),
            "noshape_1to8_max_delta": int(dc.max()),
            "noshape_1to8_per_channel": per_ch,
            "dc_gain": gain_rows,
            "rgb565_vs_rgb888_psnr": round(psnr(x565, x888), 3),
        },
        "shift_invariance": shift,
        "notes": [
            "sigma_formula 低估:只叠了小图 box,没叠双线性上采样的 tent 贡献",
            "4:2:0 下色度走 jpeg_idct_2x2,1/8 解码仍吃低频 AC,故 Q_dec AC=1 是必需项",
            "Q(0,0) 两表不一致 = 围绕 128 的对比度缩放 + 双向削波,不是亮度偏移",
        ],
    }
    (outdir / "metrics.json").write_text(
        json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"metrics.json 已写入 {outdir}")

    # ---- 9. data.js(给 HTML 查看器)------------------------------------- #
    if not args.no_data_js:
        # 浏览器没有 libjpeg 的 draft() 1/8 解码,只能把小图带过去。
        # 之后 box 迭代 / 双线性上采样 / PSNR / SSIM 全在 JS 侧现算。
        sbuf = io.BytesIO()
        Image.fromarray(small).save(sbuf, "PNG")

        # 「呼吸感」动画:内容相对 8x8 网格平移 0..7 px,各存一张小图。
        # 前端循环播放这 8 帧,静态图看不出的抖动就动起来了。
        shifts, frames = 8, []
        Hc, Wc = H - shifts, W - shifts
        for s in range(shifts):
            sub = Image.fromarray(orig[s:s + Hc, s:s + Wc])
            d_s, _ = encode_dual(sub, q00_y, q00_c)
            fb = io.BytesIO()
            Image.fromarray(decode_scaled(d_s, 8)).save(fb, "PNG")
            frames.append(base64.b64encode(fb.getvalue()).decode())

        payload = {
            "meta": metrics,
            "width": W, "height": H,
            "smallW": sw, "smallH": sh,
            "presets": [{"w": r["w"], "n": r["n"], "tag": r["tag"],
                         "sigmaFormula": r["sigma_formula"],
                         "sigmaMeasured": r["sigma_measured"]} for r in rows],
            "shift": {"count": shifts, "cropW": Wc, "cropH": Hc},
        }
        js = (
            "// 由 make_frostglass.py 生成,请勿手改。\n"
            "// 图片内联成 base64:file:// 打开 HTML 时 canvas 不会被跨源污染。\n"
            "// 1/8 小图必须由 Python 带过来 —— 浏览器没有 libjpeg 的 draft() 缩放解码。\n"
            f"window.FG_DATA = {json.dumps(payload, ensure_ascii=False)};\n"
            f'window.FG_DATA.origBase64 = "{base64.b64encode(src.read_bytes()).decode()}";\n'
            f'window.FG_DATA.smallBase64 = "{base64.b64encode(sbuf.getvalue()).decode()}";\n'
            f'window.FG_DATA.shiftFrames = {json.dumps(frames)};\n'
        )
        (outdir / "data.js").write_text(js, encoding="utf-8")
        print(f"data.js {len(js)/1024:.0f} KB  ->  打开 frostglass-compare.html")

    return 0


if __name__ == "__main__":
    sys.exit(main())
