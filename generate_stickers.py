# -*- coding: utf-8 -*-
# Generate a starter 小肥鱼 (whale-girl) sticker pack for qq-bot-pro.
# Each sticker: 512x512 PNG, soft rounded-rect bg + cute whale + bold text.
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stickers")
os.makedirs(OUT, exist_ok=True)

FONT_TEXT = "C:/Windows/Fonts/simhei.ttf"   # SimHei: CJK support
FONT_LATIN = "C:/Windows/Fonts/impact.ttf"

STICKERS = [
    ("cao", "草",        (151, 210, 120), (255,255,255)),
    ("le",  "乐",        (255, 206,  86), (255,255,255)),
    ("haoye", "好耶",    (255, 150, 180), (255,255,255)),
    ("nanbeng", "难绷",  (120, 170, 230), (255,255,255)),
    ("liu",  "6",        (170, 130, 220), (255,255,255)),
    ("caibupang", "才不胖", (120, 210, 220), (255,255,255)),
    ("duiya", "对呀",    (130, 180, 240), (255,255,255)),
    ("tietie", "贴贴",   (255, 165, 190), (255,255,255)),
    ("moyu",  "摸鱼",    (110, 200, 185), (255,255,255)),
    ("chong", "冲",      (235, 110, 100), (255,255,255)),
    ("kun",   "困",      (150, 165, 195), (255,255,255)),
    ("chigua", "吃瓜",   (140, 205, 120), (255,255,255)),
    ("dianzan", "点赞",  (240, 160,  80), (255,255,255)),
    ("kuku",  "哭哭",    (120, 160, 230), (255,255,255)),
    ("nu",    "怒",      (230, 100, 110), (255,255,255)),
    ("yiwen", "？",      (170, 175, 190), (255,255,255)),
]

S = 512
WHALE_BLUE = (120, 195, 245)
WHALE_BLUE_D = (80, 150, 210)
WHALE_BELLY = (240, 250, 255)
EYE = (40, 60, 90)
BLUSH = (255, 160, 180)

def rounded(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)

def draw_whale(d, cx, cy, scale):
    # tail (behind body)
    d.ellipse([cx - 150*scale, cy - 20*scale, cx - 40*scale, cy + 50*scale], fill=WHALE_BLUE_D)
    d.ellipse([cx - 170*scale, cy + 10*scale, cx - 60*scale, cy + 80*scale], fill=WHALE_BLUE_D)
    # body
    d.ellipse([cx - 110*scale, cy - 70*scale, cx + 110*scale, cy + 80*scale], fill=WHALE_BLUE)
    # belly
    d.ellipse([cx - 70*scale, cy + 20*scale, cx + 90*scale, cy + 95*scale], fill=WHALE_BELLY)
    # fin
    d.ellipse([cx - 15*scale, cy + 40*scale, cx + 45*scale, cy + 90*scale], fill=WHALE_BLUE_D)
    # eye
    d.ellipse([cx + 25*scale, cy - 25*scale, cx + 55*scale, cy + 5*scale], fill=EYE)
    d.ellipse([cx + 40*scale, cy - 20*scale, cx + 50*scale, cy - 10*scale], fill=(255,255,255))
    # blush
    d.ellipse([cx + 5*scale, cy + 8*scale, cx + 35*scale, cy + 26*scale], fill=BLUSH)

for name, text, bg, fg in STICKERS:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rounded(d, (6, 6, S-6, S-6), 90, bg + (255,))
    # subtle inner highlight circle top-left
    d.ellipse([40, 40, 150, 150], fill=(255,255,255,40))
    draw_whale(d, S//2, S//2 - 30, 1.0)
    # text at bottom
    size = 110 if len(text) <= 2 else 84 if len(text) == 3 else 70
    try:
        f = ImageFont.truetype(FONT_TEXT, size)
    except Exception:
        f = ImageFont.truetype(FONT_LATIN, size)
    # measure
    bbox = d.textbbox((0, 0), text, font=f)
    w = bbox[2] - bbox[0]; h = bbox[3] - bbox[1]
    tx = (S - w) // 2 - bbox[0]
    ty = S - 150 - h//2 - bbox[1]
    # shadow then text
    d.text((tx+4, ty+4), text, font=f, fill=(0,0,0,90))
    d.text((tx, ty), text, font=f, fill=fg + (255,))
    out = os.path.join(OUT, name + ".png")
    img.save(out)
    print("wrote", out)

print("DONE", len(STICKERS), "stickers in", OUT)
