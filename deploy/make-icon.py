"""Regenerate the launcher icon — same two bars as the app's favicon.
   python3 deploy/make-icon.py && sips -s format icns icon.png --out \
     deploy/Depthviz.app/Contents/Resources/depthviz.icns"""
import zlib, struct
W = H = 512
BG, GREEN, RED = (7, 8, 10), (0, 230, 118), (255, 23, 68)
px = [[BG] * W for _ in range(H)]
def rect(x, y, w, h, c):
    for j in range(y, min(y + h, H)):
        for i in range(x, min(x + w, W)):
            px[j][i] = c
rect(64, 192, 160, 256, GREEN)
rect(288, 96, 160, 352, RED)
raw = b''.join(b'\x00' + b''.join(bytes(px[y][x]) for x in range(W)) for y in range(H))
def chunk(t, d):
    c = t + d
    return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
open('icon.png', 'wb').write(
    b'\x89PNG\r\n\x1a\n'
    + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(raw, 9))
    + chunk(b'IEND', b''))
