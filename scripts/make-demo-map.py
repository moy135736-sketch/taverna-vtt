#!/usr/bin/env python3
"""
Генератор демонстрационной карты «Логово гоблинов» для примера стола.
Создаёт client/public/demo/goblin-lair.webp и server/demo/layout.json (стены, двери, точки).
Запуск: python3 scripts/make-demo-map.py   (нужен Pillow)
"""
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
CS = 70                     # пикселей в клетке
W, H = 24, 16               # клеток
random.seed(7)

# Комнаты и коридоры в клетках: (x0, y0, x1, y1), x1/y1 — не включительно
ROOMS = {
    'hall': (2, 2, 9, 7),        # зал с костром
    'barracks': (13, 2, 21, 8),  # казарма гоблинов
    'store': (3, 10, 10, 14),    # кладовая
    'boss': (14, 11, 22, 15),    # логово вожака
}
CORRIDORS = [
    (9, 4, 13, 6),     # зал → казарма
    (5, 7, 7, 10),     # зал → кладовая
    (17, 8, 19, 11),   # казарма → логово
]
# двери: отрезки в клетках (x0, y0, x1, y1)
DOORS = [
    (9, 4, 9, 6),      # из зала в коридор
    (17, 11, 19, 11),  # в логово вожака
]

floor_cells = set()
for x0, y0, x1, y1 in list(ROOMS.values()) + CORRIDORS:
    for x in range(x0, x1):
        for y in range(y0, y1):
            floor_cells.add((x, y))


def noise_tile(base, spread, size):
    im = Image.new('RGB', (size, size), base)
    px = im.load()
    for i in range(size):
        for j in range(size):
            d = random.randint(-spread, spread)
            r, g, b = base
            px[i, j] = (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)))
    return im.filter(ImageFilter.GaussianBlur(0.8))


img = Image.new('RGB', (W * CS, H * CS), (38, 34, 31))
# скальная порода
rock = noise_tile((52, 47, 43), 14, W * CS // 2).resize((W * CS, H * CS))
img.paste(rock, (0, 0))
draw = ImageDraw.Draw(img, 'RGBA')
for _ in range(900):
    x, y = random.randint(0, W * CS), random.randint(0, H * CS)
    r = random.randint(6, 26)
    shade = random.randint(28, 62)
    draw.ellipse([x - r, y - r, x + r, y + r], fill=(shade, shade - 3, shade - 6, 90))

# пол: каменные плиты с разной яркостью
for (cx, cy) in floor_cells:
    x, y = cx * CS, cy * CS
    base = random.randint(150, 172)
    tile = noise_tile((base, base - 10, base - 26), 9, CS)
    img.paste(tile, (x, y))
    draw.rectangle([x, y, x + CS - 1, y + CS - 1], outline=(110, 98, 80, 140), width=2)
    # трещины
    if random.random() < 0.25:
        sx, sy = x + random.randint(8, CS - 8), y + random.randint(8, CS - 8)
        pts = [(sx, sy)]
        for _ in range(3):
            sx += random.randint(-14, 14)
            sy += random.randint(-14, 14)
            pts.append((sx, sy))
        draw.line(pts, fill=(95, 84, 70, 160), width=2)

# тень от стен по краю пола
shadow = Image.new('L', img.size, 0)
sd = ImageDraw.Draw(shadow)
for (cx, cy) in floor_cells:
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        if (cx + dx, cy + dy) not in floor_cells:
            x, y = cx * CS, cy * CS
            if dx == 1:
                sd.rectangle([x + CS - 14, y, x + CS, y + CS], fill=150)
            if dx == -1:
                sd.rectangle([x, y, x + 14, y + CS], fill=150)
            if dy == 1:
                sd.rectangle([x, y + CS - 14, x + CS, y + CS], fill=150)
            if dy == -1:
                sd.rectangle([x, y, x + CS, y + 14], fill=170)
shadow = shadow.filter(ImageFilter.GaussianBlur(9))
dark = Image.new('RGB', img.size, (20, 16, 12))
img = Image.composite(dark, img, shadow.point(lambda v: int(v * 0.75)))
draw = ImageDraw.Draw(img, 'RGBA')

# двери
for x0, y0, x1, y1 in DOORS:
    X0, Y0, X1, Y1 = x0 * CS, y0 * CS, x1 * CS, y1 * CS
    if X0 == X1:
        draw.rectangle([X0 - 9, Y0 + 4, X0 + 9, Y1 - 4], fill=(118, 74, 36), outline=(60, 36, 16), width=3)
        for k in range(1, 4):
            yy = Y0 + (Y1 - Y0) * k / 4
            draw.line([(X0 - 9, yy), (X0 + 9, yy)], fill=(80, 50, 24), width=2)
    else:
        draw.rectangle([X0 + 4, Y0 - 9, X1 - 4, Y0 + 9], fill=(118, 74, 36), outline=(60, 36, 16), width=3)
        for k in range(1, 4):
            xx = X0 + (X1 - X0) * k / 4
            draw.line([(xx, Y0 - 9), (xx, Y0 + 9)], fill=(80, 50, 24), width=2)


def barrel(cx, cy, r=24):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(112, 70, 34), outline=(52, 30, 12), width=4)
    draw.ellipse([cx - r + 8, cy - r + 8, cx + r - 8, cy + r - 8], outline=(80, 48, 20), width=3)


def crate(x, y, s=50):
    draw.rectangle([x, y, x + s, y + s], fill=(140, 98, 52), outline=(70, 44, 20), width=4)
    draw.line([(x, y), (x + s, y + s)], fill=(90, 60, 28), width=4)
    draw.line([(x + s, y), (x, y + s)], fill=(90, 60, 28), width=4)


def bedroll(x, y):
    draw.rounded_rectangle([x, y, x + 46, y + 110], 14, fill=(96, 112, 70), outline=(50, 60, 30), width=3)
    draw.rounded_rectangle([x + 6, y + 6, x + 40, y + 30], 8, fill=(170, 160, 130))


# зал: костёр
fx, fy = 5.5 * CS, 4.5 * CS
for r, c in ((60, (255, 160, 60, 40)), (40, (255, 180, 80, 70))):
    draw.ellipse([fx - r, fy - r, fx + r, fy + r], fill=c)
for a in range(0, 360, 40):
    rx, ry = fx + 28 * math.cos(math.radians(a)), fy + 28 * math.sin(math.radians(a))
    draw.ellipse([rx - 9, ry - 7, rx + 9, ry + 7], fill=(90, 86, 80), outline=(50, 48, 44), width=2)
draw.ellipse([fx - 16, fy - 16, fx + 16, fy + 16], fill=(255, 140, 30))
draw.ellipse([fx - 8, fy - 9, fx + 8, fy + 7], fill=(255, 230, 120))
# казарма: подстилки
for i in range(4):
    bedroll(14 * CS + 20 + i * 90, 2 * CS + 30)
# кладовая: бочки и ящики
for i, (bx, by) in enumerate([(3.6, 10.6), (4.4, 10.5), (3.7, 13.3), (9.3, 13.3)]):
    barrel(bx * CS, by * CS)
crate(8.2 * CS, 10.2 * CS)
crate(9.0 * CS, 10.5 * CS, 44)
# логово: стол и трон
draw.rounded_rectangle([19.2 * CS, 12.2 * CS, 21.6 * CS, 13.4 * CS], 10, fill=(120, 80, 42), outline=(60, 38, 18), width=4)
draw.rounded_rectangle([15 * CS, 13.6 * CS, 16 * CS, 14.8 * CS], 8, fill=(90, 40, 40), outline=(40, 16, 16), width=4)
# сундук с сокровищем
draw.rectangle([20.5 * CS, 14.0 * CS, 21.6 * CS, 14.7 * CS], fill=(150, 104, 40), outline=(80, 52, 14), width=4)
draw.rectangle([20.95 * CS, 14.15 * CS, 21.15 * CS, 14.45 * CS], fill=(230, 200, 90))

out_img = ROOT / 'client' / 'public' / 'demo'
out_img.mkdir(parents=True, exist_ok=True)
img.save(out_img / 'goblin-lair.webp', 'WEBP', quality=82, method=6)

# Стены: контур пола (отрезки на границе пол/порода), объединённые в ломаные
edges = []
for (cx, cy) in floor_cells:
    if (cx, cy - 1) not in floor_cells:
        edges.append(((cx, cy), (cx + 1, cy)))
    if (cx, cy + 1) not in floor_cells:
        edges.append(((cx, cy + 1), (cx + 1, cy + 1)))
    if (cx - 1, cy) not in floor_cells:
        edges.append(((cx, cy), (cx, cy + 1)))
    if (cx + 1, cy) not in floor_cells:
        edges.append(((cx + 1, cy), (cx + 1, cy + 1)))
# склеиваем соседние отрезки одного направления
def merge(edges):
    horiz = {}
    vert = {}
    for a, b in edges:
        if a[1] == b[1]:
            horiz.setdefault(a[1], []).append((min(a[0], b[0]), max(a[0], b[0])))
        else:
            vert.setdefault(a[0], []).append((min(a[1], b[1]), max(a[1], b[1])))
    out = []
    for y, segs in horiz.items():
        segs.sort()
        cur = list(segs[0])
        for s in segs[1:]:
            if s[0] == cur[1]:
                cur[1] = s[1]
            else:
                out.append(((cur[0], y), (cur[1], y)))
                cur = list(s)
        out.append(((cur[0], y), (cur[1], y)))
    for x, segs in vert.items():
        segs.sort()
        cur = list(segs[0])
        for s in segs[1:]:
            if s[0] == cur[1]:
                cur[1] = s[1]
            else:
                out.append(((x, cur[0]), (x, cur[1])))
                cur = list(s)
        out.append(((x, cur[0]), (x, cur[1])))
    return out

walls = [[a[0] * CS, a[1] * CS, b[0] * CS, b[1] * CS] for a, b in merge(edges)]
layout = {
    'cell': CS,
    'width': W,
    'height': H,
    'map': '/demo/goblin-lair.webp',
    'walls': walls,
    'doors': [[x0 * CS, y0 * CS, x1 * CS, y1 * CS] for x0, y0, x1, y1 in DOORS],
    'fire': [fx, fy],
    'spots': {
        'hero': [3, 3],
        'goblins': [[15, 4], [17, 5], [19, 3]],
        'boss': [17, 13],
        'treasure': [21, 14],
    },
    'reveal': [ROOMS['hall'][0] * CS, ROOMS['hall'][1] * CS, (ROOMS['hall'][2] - ROOMS['hall'][0]) * CS, (ROOMS['hall'][3] - ROOMS['hall'][1]) * CS],
}
out_json = ROOT / 'server' / 'demo'
out_json.mkdir(parents=True, exist_ok=True)
(out_json / 'layout.json').write_text(json.dumps(layout, ensure_ascii=False, indent=1), encoding='utf-8')
print('карта:', out_img / 'goblin-lair.webp', (out_img / 'goblin-lair.webp').stat().st_size, 'байт; стен:', len(walls))
