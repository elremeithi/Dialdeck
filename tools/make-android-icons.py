# Generates Android launcher icons (adaptive foreground + legacy) from the same design as the extension icon.
import sys, os
from PIL import Image, ImageDraw

def glyph(S):
    """Accent-gradient rounded square with a 2x2 dial grid, S x S RGBA."""
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        gd.line([(0, y), (S, y)], fill=(int(91 + 33 * t), int(140 - 63 * t), int(255 - 36 * t), 255))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    pad, gap = S * 0.2, S * 0.09
    cell = (S - 2 * pad - gap) / 2
    for i in range(2):
        for j in range(2):
            x, y = pad + j * (cell + gap), pad + i * (cell + gap)
            d.rounded_rectangle([x, y, x + cell, y + cell * 0.82], radius=int(cell * 0.18), fill=(255, 255, 255, 255 if (i, j) != (1, 1) else 150))
    return img

res = sys.argv[1]
dens = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, k in dens.items():
    d = os.path.join(res, f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    # adaptive foreground: 108dp canvas, glyph inside the 66dp safe zone
    fg_size = int(108 * k)
    fg = Image.new('RGBA', (fg_size, fg_size), (0, 0, 0, 0))
    g = glyph(int(64 * k) * 4).resize((int(64 * k), int(64 * k)), Image.LANCZOS)
    off = (fg_size - g.width) // 2
    fg.paste(g, (off, off), g)
    fg.save(os.path.join(d, 'ic_launcher_foreground.png'))
    # legacy icon for launchers without adaptive icons: glyph on black rounded square
    L = int(48 * k)
    leg = Image.new('RGBA', (L * 4, L * 4), (0, 0, 0, 0))
    ImageDraw.Draw(leg).rounded_rectangle([0, 0, L * 4 - 1, L * 4 - 1], radius=int(L * 4 * 0.22), fill=(0, 0, 0, 255))
    gg = glyph(int(L * 4 * 0.78))
    o = (L * 4 - gg.width) // 2
    leg.paste(gg, (o, o), gg)
    leg.resize((L, L), Image.LANCZOS).save(os.path.join(d, 'ic_launcher.png'))
os.makedirs(os.path.join(res, 'mipmap-anydpi-v26'), exist_ok=True)
open(os.path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'w').write(
    '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
    '    <background android:drawable="@color/icon_background"/>\n    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
    '</adaptive-icon>\n')
print('android icons ok')
