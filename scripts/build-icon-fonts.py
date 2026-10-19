#!/usr/bin/env python3
"""
Сборка шрифтов-заменителей для иконочных шрифтов Roll20 (Pictos, Pictos Custom,
Pictos Three, dicefontd4…d20), которые используют листы персонажей.

Оригинальные шрифты Roll20 лицензированы и не распространяются, поэтому мы
берём подходящие иконки из Font Awesome Free (SIL OFL 1.1) и раскладываем их по
тем же символам. Соответствие приблизительное — подобрано по тому, как символы
используются в листах репозитория roll20-character-sheets.

Запуск (нужен пакет fonttools + brotli):
  npm pack @fortawesome/fontawesome-free@6.7.2 && tar xzf fortawesome-*.tgz
  python3 scripts/build-icon-fonts.py package/webfonts/fa-solid-900.ttf client/public/fonts/r20
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

PICTOS = {
    'y': 'gear', '#': 'trash-can', '&': 'plus', '+': 'plus', '-': 'minus', '=': 'equals',
    '3': 'check', 'V': 'check', '*': 'xmark', 'x': 'xmark', 'i': 'circle-info',
    '?': 'circle-question', '!': 'circle-exclamation', 'D': 'circle-exclamation',
    '(': 'pencil', 'p': 'pencil', '1': 'arrows-rotate', 'S': 'star', 'k': 'user',
    '{': 'chevron-left', '}': 'chevron-right', '[': 'caret-left', ']': 'caret-right',
    '<': 'angle-left', '>': 'angle-right', 'l': 'table-list', 'L': 'lock', 'U': 'lock-open',
    'j': 'link', 'O': 'briefcase', 'W': 'file-lines', 'a': 'weight-hanging', 'h': 'coins',
    '8': 'bolt', 'n': 'wand-magic-sparkles', 'r': 'circle', '9': 'hashtag', 'E': 'envelope',
    'f': 'magnifying-glass', 'Z': 'moon', 'z': 'eye', 'u': 'user', 'P': 'print',
    '0': 'bars', 'w': 'comment', 's': 'heart', 'b': 'shield-halved', 'g': 'book',
}
PICTOS_CUSTOM = {'t': 'triangle-exclamation', 'e': 'shield-halved', 'a': 'hand-fist', 'b': 'shield', 'd': 'skull'}
PICTOS_THREE = {'b': 'shield', 'g': 'book', 'a': 'heart', 'c': 'skull', 'd': 'crown'}

ALNUM = [chr(c) for c in range(0x21, 0x7f)]


def dice_map(glyph, faces=None):
    m = {ch: glyph for ch in ALNUM}
    for k, v in (faces or {}).items():
        m[k] = v
    return m


D6_FACES = {'1': 'dice-one', '2': 'dice-two', '3': 'dice-three', '4': 'dice-four', '5': 'dice-five', '6': 'dice-six'}

FONTS = {
    'pictos': ('Pictos', PICTOS),
    'pictos-custom': ('Pictos Custom', PICTOS_CUSTOM),
    'pictos-three': ('Pictos Three', PICTOS_THREE),
    'dicefont-d4': ('dicefontd4', dice_map('dice-d20')),
    'dicefont-d6': ('dicefontd6', dice_map('dice-d6', D6_FACES)),
    'dicefont-d8': ('dicefontd8', dice_map('dice-d20')),
    'dicefont-d10': ('dicefontd10', dice_map('dice-d20')),
    'dicefont-d12': ('dicefontd12', dice_map('dice-d20')),
    'dicefont-d20': ('dicefontd20', dice_map('dice-d20')),
}


def build(src, mapping, family, out):
    font = TTFont(src)
    glyphs = sorted(set(mapping.values()))
    missing = [g for g in glyphs if g not in font.getGlyphOrder()]
    if missing:
        raise SystemExit(f'нет глифов в {src}: {missing}')
    opts = subset.Options()
    opts.layout_features = []
    opts.name_IDs = [0, 13, 14]  # копирайт и лицензия OFL остаются
    opts.glyph_names = True
    opts.notdef_outline = True
    sub = subset.Subsetter(opts)
    sub.populate(glyphs=glyphs)
    sub.subset(font)
    cmap = {ord(ch): g for ch, g in mapping.items()}
    for t in font['cmap'].tables:
        if t.isUnicode():
            t.cmap = dict(cmap)
    # своё имя: модифицированная версия OFL-шрифта не может носить исходное имя
    ps = 'Taverna' + family.replace(' ', '')
    name = font['name']
    for nid, val in ((1, 'Taverna ' + family), (2, 'Regular'), (3, ps + '-1.0'), (4, 'Taverna ' + family), (6, ps)):
        name.setName(val, nid, 3, 1, 0x409)
    os2 = font['OS/2']
    os2.usFirstCharIndex = min(cmap)
    os2.usLastCharIndex = max(cmap)
    os2.recalcUnicodeRanges(font)
    font.flavor = 'woff2'
    font.save(out)
    return out.stat().st_size


def main():
    src = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    # @font-face для этих файлов объявлены в client/src/game/sheet/base-css.js (R20_FONT_FILES)
    for file, (family, mapping) in FONTS.items():
        size = build(src, mapping, family, out_dir / f'{file}.woff2')
        print(f'{file}.woff2 ({family}) — {size} байт')


if __name__ == '__main__':
    main()
