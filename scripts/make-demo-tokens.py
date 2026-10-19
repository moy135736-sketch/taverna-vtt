#!/usr/bin/env python3
"""Простые рисованные токены для примера стола: паладин, гоблин, хобгоблин-вожак."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'client' / 'public' / 'demo'
OUT.mkdir(parents=True, exist_ok=True)
S = 256


def base(bg, ring):
    im = Image.new('RGBA', (S * 2, S * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([12, 12, S * 2 - 12, S * 2 - 12], fill=bg, outline=ring, width=22)
    return im, d


def finish(im, name):
    im = im.resize((S, S), Image.LANCZOS)
    im.save(OUT / name)


# паладин: синий фон, серебряный шлем с плюмажем
im, d = base((52, 82, 140, 255), (210, 180, 90, 255))
d.ellipse([150, 120, 362, 360], fill=(196, 204, 214, 255), outline=(90, 96, 110, 255), width=10)   # шлем
d.rectangle([180, 240, 332, 262], fill=(40, 44, 54, 255))                                          # прорезь
d.rectangle([246, 262, 266, 330], fill=(40, 44, 54, 255))
d.polygon([(256, 60), (300, 130), (212, 130)], fill=(190, 40, 40, 255))                            # плюмаж
d.rectangle([150, 360, 362, 420], fill=(170, 176, 188, 255), outline=(90, 96, 110, 255), width=8)  # наплечник
finish(im, 'paladin.png')

# гоблин: зелёное лицо, большие уши, жёлтые глаза
im, d = base((70, 60, 44, 255), (120, 150, 60, 255))
d.polygon([(130, 230), (40, 150), (170, 200)], fill=(110, 160, 70, 255), outline=(50, 80, 30, 255))
d.polygon([(382, 230), (472, 150), (342, 200)], fill=(110, 160, 70, 255), outline=(50, 80, 30, 255))
d.ellipse([140, 140, 372, 400], fill=(120, 172, 76, 255), outline=(50, 80, 30, 255), width=10)
d.ellipse([190, 220, 240, 260], fill=(250, 220, 60, 255))
d.ellipse([272, 220, 322, 260], fill=(250, 220, 60, 255))
d.ellipse([207, 230, 223, 252], fill=(20, 20, 20, 255))
d.ellipse([289, 230, 305, 252], fill=(20, 20, 20, 255))
d.arc([200, 280, 312, 350], 20, 160, fill=(40, 20, 20, 255), width=8)
d.polygon([(226, 318), (236, 336), (246, 318)], fill=(240, 240, 220, 255))
d.polygon([(266, 318), (276, 336), (286, 318)], fill=(240, 240, 220, 255))
finish(im, 'goblin.png')

# хобгоблин-вожак: рыжая кожа, рога, шрам
im, d = base((60, 30, 26, 255), (190, 60, 40, 255))
d.polygon([(170, 170), (120, 60), (210, 150)], fill=(230, 220, 190, 255), outline=(90, 80, 60, 255))
d.polygon([(342, 170), (392, 60), (302, 150)], fill=(230, 220, 190, 255), outline=(90, 80, 60, 255))
d.ellipse([140, 130, 372, 400], fill=(200, 100, 50, 255), outline=(90, 40, 20, 255), width=10)
d.rectangle([180, 220, 240, 245], fill=(255, 230, 80, 255))
d.rectangle([272, 220, 332, 245], fill=(255, 230, 80, 255))
d.line([(300, 180), (340, 290)], fill=(120, 30, 30, 255), width=8)
d.rectangle([200, 300, 312, 330], fill=(60, 20, 10, 255))
finish(im, 'hobgoblin.png')
print('токены готовы:', ', '.join(p.name for p in OUT.glob('*.png')))
