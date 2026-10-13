#!/usr/bin/env python3
"""从仓库内品牌图生成应用图标。

源：src/renderer/assets/brand-icon.png
写出：build/icon.png（字节复制）、build/icon-512.png、build/icon.ico（16–256）。
不绘制占位图。没有 Pillow 时只复制 png，并跳过 512 与 ico。
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src', 'renderer', 'assets', 'brand-icon.png')
BUILD = os.path.join(ROOT, 'build')
ICON = os.path.join(BUILD, 'icon.png')
ICON_512 = os.path.join(BUILD, 'icon-512.png')
ICON_ICO = os.path.join(BUILD, 'icon.ico')
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> int:
    if not os.path.isfile(SRC):
        print('缺少 src/renderer/assets/brand-icon.png', file=sys.stderr)
        return 1
    os.makedirs(BUILD, exist_ok=True)
    shutil.copyfile(SRC, ICON)
    try:
        from PIL import Image
    except ImportError:
        print('已复制 build/icon.png。未安装 Pillow，未生成 icon-512.png 与 icon.ico。', file=sys.stderr)
        return 2
    im = Image.open(SRC).convert('RGBA')
    im.resize((512, 512), Image.Resampling.LANCZOS).save(ICON_512)
    im.save(ICON_ICO, sizes=ICO_SIZES)
    print('build/icon.png, build/icon-512.png, build/icon.ico')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
