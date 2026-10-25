"""
生成安卓版应用图标：把官网的 qunzai-icon-256.png 裁成方形，生成各密度 mipmap，
并生成 adaptive-icon 的前景层（带 66% 安全边距）。
"""
import os
from PIL import Image

SRC = r"C:\Users\14132\Documents\默认项目\open-source\DeepPupil\site\assets\qunzai-icon-256.png"
RES = r"D:\qz-build\android\app\src\main\res"

# Android 启动器图标密度 -> 边长
DENSITIES = {
    'mdpi': 48,
    'hdpi': 72,
    'xhdpi': 96,
    'xxhdpi': 144,
    'xxxhdpi': 192,
}

BG = (13, 17, 23, 255)  # #0d1117，与 ic_launcher_background 一致


def square(img):
    """把图裁成正方形（居中）。"""
    w, h = img.size
    if w == h:
        return img
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def main():
    src = Image.open(SRC).convert('RGBA')
    src = square(src)

    # ---- 传统图标：整张图铺满
    for dens, size in DENSITIES.items():
        d = os.path.join(RES, 'mipmap-' + dens)
        os.makedirs(d, exist_ok=True)
        out = src.resize((size, size), Image.LANCZOS)
        path = os.path.join(d, 'ic_launcher.png')
        out.save(path, 'PNG', optimize=True)
        print('legacy', path, out.size, os.path.getsize(path))

    # ---- adaptive icon 前景：108dp 画布，内容占 66%（安全区）
    for dens, size in DENSITIES.items():
        d = os.path.join(RES, 'mipmap-' + dens)
        canvas_px = int(size * 108 / 48)
        inner = int(canvas_px * 0.62)
        fg = Image.new('RGBA', (canvas_px, canvas_px), (0, 0, 0, 0))
        art = src.resize((inner, inner), Image.LANCZOS)
        off = (canvas_px - inner) // 2
        fg.paste(art, (off, off), art)
        path = os.path.join(d, 'ic_launcher_fg.png')
        fg.save(path, 'PNG', optimize=True)
        print('adaptive', path, fg.size, os.path.getsize(path))


if __name__ == '__main__':
    main()
