#!/usr/bin/env python
"""生成/重编码 720p、1080p 的 H.264 测试片源。

覆盖不同 profile / level / GOP / B 帧结构，用来对比解码带宽。
默认用 lavfi 合成源（有真实运动），无需联网。

用法：
    python make_samples.py                 # 全部生成到 samples/
    python make_samples.py --only 720p     # 只生成名字里含 720p 的
    python make_samples.py --source a.mp4  # 换成本地素材重编码
    python make_samples.py --list
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "samples")

# name, 源尺寸, x264 参数, 说明
PRESETS = [
    ("720p_baseline_L31", "1280x720",
     ["-profile:v", "baseline", "-level", "3.1", "-bf", "0", "-g", "30",
      "-b:v", "3M", "-x264-params", "ref=1:cabac=0:8x8dct=0"],
     "Baseline 无 B 帧、CAVLC、单参考"),
    ("720p_main_L31", "1280x720",
     ["-profile:v", "main", "-level", "3.1", "-bf", "2", "-g", "30",
      "-b:v", "3M", "-x264-params", "ref=2:8x8dct=0"],
     "Main、CABAC、2 参考、B=2"),
    ("720p_high_L31_b3", "1280x720",
     ["-profile:v", "high", "-level", "3.1", "-bf", "3", "-g", "60",
      "-b:v", "4M", "-x264-params", "ref=4:b-pyramid=normal"],
     "High、8x8 变换、B=3、金字塔 B"),
    ("720p_high_L31_manyref", "1280x720",
     ["-profile:v", "high", "-level", "3.1", "-bf", "3", "-g", "60",
      "-b:v", "4M", "-x264-params", "ref=8"],
     "参考帧多（Cache 竞争）"),
    ("1080p_high_L40_b3", "1920x1080",
     ["-profile:v", "high", "-level", "4.0", "-bf", "3", "-g", "60",
      "-b:v", "8M", "-x264-params", "ref=4:b-pyramid=normal"],
     "1080p 基准"),
    ("1080p_high_L40_allp", "1920x1080",
     ["-profile:v", "high", "-level", "4.0", "-bf", "0", "-g", "60",
      "-b:v", "8M", "-x264-params", "ref=2"],
     "没有 B 帧（对照：N_dir 更低但码率更高）"),
    ("1080p_high_L42_b3_hi", "1920x1080",
     ["-profile:v", "high", "-level", "4.2", "-bf", "3", "-g", "120",
      "-b:v", "20M", "-x264-params", "ref=4"],
     "高码率、长 GOP"),
    ("1080p_high_L40_intra", "1920x1080",
     ["-profile:v", "high", "-level", "4.0", "-g", "1",
      "-b:v", "12M"],
     "全 I 帧（无帧间读取，只有码流+写回）"),
]


def make(name, size, params, desc, source, duration):
    dst = os.path.join(OUT, name + ".h264")
    if source:
        cmd = ["ffmpeg", "-y", "-i", source, "-an", "-c:v", "libx264",
               "-pix_fmt", "yuv420p", "-s", size] + params + [dst]
    else:
        cmd = ["ffmpeg", "-y", "-f", "lavfi",
               "-i", "testsrc2=size=%s:rate=30:duration=%s" % (size, duration),
               "-c:v", "libx264", "-pix_fmt", "yuv420p"] + params + [dst]
    print("→ %s  (%s)" % (name, desc))
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("   %s  %.1f KB" % (dst, os.path.getsize(dst) / 1024.0))
    return dst


def main(argv):
    os.makedirs(OUT, exist_ok=True)
    only = None
    source = None
    duration = "3"
    i = 1
    while i < len(argv):
        a = argv[i]
        if a == "--only":
            only = argv[i + 1]; i += 2
        elif a == "--source":
            source = argv[i + 1]; i += 2
        elif a == "--duration":
            duration = argv[i + 1]; i += 2
        elif a == "--list":
            for name, size, _, desc in PRESETS:
                print("%-26s %-10s %s" % (name, size, desc))
            return 0
        else:
            print("未知参数", a)
            return 2
        i += 1

    for name, size, params, desc in PRESETS:
        if only and only not in name:
            continue
        make(name, size, params, desc, source, duration)
    print("\n完成，输出目录：%s" % OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
