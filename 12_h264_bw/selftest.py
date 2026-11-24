#!/usr/bin/env python
"""带宽模型自检：把需求 2.4 的表格逐条对一遍。

    python selftest.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from h264bw.bandwidth import fetch_bytes, ideal_bytes, level_maxbr_bytes, _pct   # noqa: E402


def check(name, got, want):
    ok = abs(got - want) < 1e-9
    print("  %-42s %8.1f  %s" % (name, got, "ok" if ok else "期望 %.1f ✗" % want))
    return ok


def main():
    print("2.4 参考帧读取规则（亮度 + 2×色度，8bit）")
    ok = True
    # 16x16：亮度 256 + 色度 2×64 = 384
    ok &= check("16x16 整数 MV", fetch_bytes(16, 16, False, False), 384)
    # 仅水平分数：亮度 21×16=336，色度每分量 9×8=72 → 336+144
    ok &= check("16x16 仅水平分数", fetch_bytes(16, 16, True, False), 336 + 144)
    # 仅垂直分数：亮度 16×21=336，色度 8×9=72 → 336+144
    ok &= check("16x16 仅垂直分数", fetch_bytes(16, 16, False, True), 336 + 144)
    # 两方向都分数：亮度 21×21=441，色度 9×9=81 → 441+162
    ok &= check("16x16 双向分数", fetch_bytes(16, 16, True, True), 441 + 162)

    ok &= check("16x8 双向分数", fetch_bytes(16, 8, True, True), 21 * 13 + 2 * (9 * 5))
    ok &= check("8x16 双向分数", fetch_bytes(8, 16, True, True), 13 * 21 + 2 * (5 * 9))
    ok &= check("8x8 整数 MV", fetch_bytes(8, 8, False, False), 64 + 2 * 16)
    ok &= check("8x8 双向分数", fetch_bytes(8, 8, True, True), 13 * 13 + 2 * (5 * 5))
    ok &= check("4x4 双向分数", fetch_bytes(4, 4, True, True), 9 * 9 + 2 * (3 * 3))

    print("\n理想读取（不含扩边）= 块面积 × 1.5")
    ok &= check("16x16", ideal_bytes(16, 16), 384)
    ok &= check("8x8", ideal_bytes(8, 8), 96)

    print("\n扩边放大倍数（K_interp 的构成）")
    for w, h, fx, fy in ((16, 16, True, True), (16, 16, True, False), (8, 8, True, True)):
        got = fetch_bytes(w, h, fx, fy) / float(ideal_bytes(w, h))
        print("  %-42s %8.3f" % ("%dx%d frac(%s,%s)" % (w, h, fx, fy), got))

    print("\nLevel 码流上限（1080p30、High 档）")
    mb = level_maxbr_bytes(40, True, 30.0)
    ok &= check("L4.0 @1080p30 每帧字节", mb, 25000000.0 / 8 / 30)

    print("\n百分位")
    vals = list(range(1, 101))
    ok &= check("P95 of 1..100（最近秩）", _pct(vals, 0.95), 95)
    ok &= check("P99 of 1..100（最近秩）", _pct(vals, 0.99), 99)

    print("\n结论：%s" % ("全部通过 ✓" if ok else "有失败项 ✗"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
