"""生成扩展图标：粉紫渐变圆角方块 + 白色聊天气泡。"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient(size: int) -> Image.Image:
    top = np.array([254, 44, 85], dtype=np.float32)
    bottom = np.array([139, 92, 246], dtype=np.float32)
    y = np.linspace(0.0, 1.0, size, dtype=np.float32)[:, None]
    x = np.linspace(0.0, 1.0, size, dtype=np.float32)[None, :]
    t = np.clip(y * 0.72 + x * 0.28, 0.0, 1.0)
    rows = top[None, None, :] * (1 - t[..., None]) + bottom[None, None, :] * t[..., None]
    return Image.fromarray(rows.astype(np.uint8), mode="RGB")


def build() -> Image.Image:
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    grad = gradient(SIZE).convert("RGBA")
    base.paste(grad, (0, 0), rounded_mask(SIZE, 224))

    # 顶部高光
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    gdraw.ellipse((-260, -420, 760, 380), fill=(255, 255, 255, 26))
    glow = glow.filter(ImageFilter.GaussianBlur(80))
    base.alpha_composite(Image.composite(glow, Image.new("RGBA", (SIZE, SIZE)), rounded_mask(SIZE, 224)))

    # 气泡阴影
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle((206, 258, 818, 690), radius=150, fill=(60, 8, 40, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(34))
    base.alpha_composite(shadow)

    # 白色聊天气泡（带左下角小尾巴）
    bubble = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(bubble)
    bdraw.rounded_rectangle((196, 226, 828, 642), radius=148, fill=(255, 255, 255, 255))
    bdraw.polygon([(300, 600), (300, 768), (466, 632)], fill=(255, 255, 255, 255))
    base.alpha_composite(bubble)

    # 气泡内三个点
    dots = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ddraw = ImageDraw.Draw(dots)
    for cx in (364, 512, 660):
        ddraw.ellipse((cx - 46, 388, cx + 46, 480), fill=(254, 44, 85, 255))
    base.alpha_composite(dots)

    # 右上角青色点缀
    accent = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    adraw = ImageDraw.Draw(accent)
    adraw.ellipse((740, 150, 892, 302), fill=(37, 244, 238, 255))
    adraw.ellipse((770, 180, 862, 272), fill=(254, 44, 85, 0))
    base.alpha_composite(accent)

    return base


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: make-icons.py <output-dir>")
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)

    master = build()
    for size in (16, 32, 48, 128, 256):
        icon = master.resize((size, size), Image.LANCZOS)
        icon.save(out_dir / f"icon{size}.png", optimize=True)
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
