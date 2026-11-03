#!/usr/bin/env python3
"""把 10_scale_img/ 下的示例图内联成 sample-data.js。

默认打包 wp-3.png(466×466)。产物让 scale-compare.html 双击直接打开就能用,
绕开 file:// 下 drawImage 外部文件污染 canvas、导致 getImageData 抛
SecurityError 的问题。

    python make_sample.py
    python make_sample.py --scale 0.5      # 缩小内联体积
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "sample-data.js"


def collect(paths: list[Path]) -> list[dict]:
    items = []
    for p in paths:
        raw = p.read_bytes()
        try:
            from PIL import Image  # 可选:装了 Pillow 才能缩图 / 转 RGBA
        except ImportError:
            Image = None
        if Image is not None:
            try:
                im = Image.open(io.BytesIO(raw)).convert("RGBA")
                buf = io.BytesIO()
                im.save(buf, format="PNG", optimize=True)
                raw = buf.getvalue()
            except Exception as e:  # noqa: BLE001
                print(f"  ! {p.name}: Pillow 处理失败,用原文件 ({e})", file=sys.stderr)
        b64 = base64.b64encode(raw).decode("ascii")
        items.append({
            "name": p.name,
            "src": f"data:image/png;base64,{b64}",
        })
        print(f"  {p.name}: {len(raw) / 1024:.1f} KB")
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--out", type=Path, default=DEFAULT_OUT, help="输出文件")
    ap.add_argument("images", nargs="*", type=Path, help="示例图(默认 wp-3.png)")
    args = ap.parse_args()

    paths = args.images or [HERE / "wp-3.png"]
    paths = [p for p in paths if p.exists()]
    if not paths:
        print("没有可打包的图片", file=sys.stderr)
        return 1

    items = collect(paths)
    body = ",\n".join(
        "  " + json.dumps(it, ensure_ascii=False) for it in items
    )
    args.out.write_text(
        "/* 由 make_sample.py 生成,勿手改。 */\n"
        f"window.SAMPLE = [\n{body}\n];\n",
        encoding="utf-8",
    )
    total = args.out.stat().st_size
    print(f"→ {args.out}  ({total / 1024:.1f} KB, {len(items)} 张)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
