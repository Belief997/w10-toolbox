#!/usr/bin/env python
"""准备 mvdump：下载 FFmpeg *shared* 版（要它的 include/lib 和 DLL），编译小工具。

系统里装的 ffmpeg 若是静态版（gyan essentials 那种），导出符号不在，
所以这里单独拉一份 shared 构建，只放在本目录下，不影响系统 PATH。

用法：  python mvtool/prepare.py [--force]
"""

import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FF = os.path.join(HERE, "ff")
BIN = os.path.join(HERE, "mvdump.exe")
SRC = os.path.join(HERE, "mvdump.c")
ZIP = os.path.join(HERE, "ffshared.zip")

# BtbN 的 win64 gpl-shared 构建（含 bin/*.dll、include/、lib/）
URL = ("https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/"
       "ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip")


def download():
    print("下载 FFmpeg shared 构建（约 86MB，只需一次）...")
    tmp = ZIP + ".part"
    with urllib.request.urlopen(URL, timeout=120) as r, open(tmp, "wb") as fh:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
            done += len(chunk)
            if total:
                sys.stdout.write("\r  %.1f / %.1f MB" % (done / 1e6, total / 1e6))
                sys.stdout.flush()
    os.replace(tmp, ZIP)
    print("")


def extract():
    print("解压 ...")
    with zipfile.ZipFile(ZIP) as z:
        names = z.namelist()
        root = names[0].split("/")[0]
        for n in names:
            if "/include/" in n or "/lib/" in n or "/bin/" in n:
                rel = n[len(root) + 1:]
                dst = os.path.join(FF, rel)
                if n.endswith("/"):
                    continue
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with z.open(n) as src, open(dst, "wb") as out:
                    shutil.copyfileobj(src, out)
    if os.path.exists(ZIP):
        os.remove(ZIP)


def build():
    print("编译 mvdump.exe ...")
    cmd = ["gcc", "-O2", "-o", BIN, SRC,
           "-I", os.path.join(FF, "include"),
           "-L", os.path.join(FF, "lib"),
           "-lavformat", "-lavcodec", "-lavutil"]
    subprocess.check_call(cmd)
    print("完成：%s" % BIN)


def main(argv):
    force = "--force" in argv
    if not force and os.path.exists(BIN):
        print("mvdump.exe 已存在，无需准备（--force 可强制重建）")
        return 0
    if force or not os.path.isdir(os.path.join(FF, "include")):
        if not os.path.exists(ZIP):
            download()
        extract()
    build()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
