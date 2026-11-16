# Generates the extension icons (2x2 dial grid on an accent gradient).
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
for size in (16, 32, 48, 128):
    S = size * 4
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    grad = Image.new('RGBA', (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / S
        gd.line([(0, y), (S, y)], fill=(int(91 + (124 - 91) * t), int(140 + (77 - 140) * t), int(255 + (219 - 255) * t), 255))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    pad, gap = S * 0.2, S * 0.09
    cell = (S - 2 * pad - gap) / 2
    for i in range(2):
        for j in range(2):
            x, y = pad + j * (cell + gap), pad + i * (cell + gap)
            a = 255 if (i, j) != (1, 1) else 150
            d.rounded_rectangle([x, y, x + cell, y + cell * 0.82], radius=int(cell * 0.18), fill=(255, 255, 255, a))
    img.resize((size, size), Image.LANCZOS).save(f'{out}/icon-{size}.png')
print('icons ok')
