"""Generate ghost-term icon (.ico) with cyberpunk ghost design."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import io, math, random, struct

random.seed(42)

def draw_icon(size):
    """Draw ghost-term icon at given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    s = size / 256  # scale factor

    # Background
    bg = (10, 14, 20, 255)
    r = int(24 * s)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=bg)

    # Subtle border
    cyan = (0, 229, 255)
    draw.rounded_rectangle(
        [int(2*s), int(2*s), size - 1 - int(2*s), size - 1 - int(2*s)],
        radius=max(1, r - int(2*s)), fill=None,
        outline=(*cyan, 60), width=max(1, int(1.5 * s))
    )

    # Ghost parameters — compact ghost, lots of breathing room
    cx = size // 2
    ghost_top = int(70 * s)
    head_r = int(32 * s)
    ghost_width = int(36 * s)
    ghost_bottom = int(155 * s)
    ghost_alpha = 150

    # Glow behind ghost
    if size >= 48:
        glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        ex = int(20 * s)
        gd.ellipse([cx - head_r - ex, ghost_top - ex,
                     cx + head_r + ex, ghost_top + head_r * 2 + ex],
                    fill=(0, 229, 255, 20))
        gd.rectangle([cx - ghost_width - ex, ghost_top + head_r,
                       cx + ghost_width + ex, ghost_bottom + ex],
                      fill=(0, 229, 255, 15))
        glow = glow.filter(ImageFilter.GaussianBlur(radius=int(12 * s)))
        img = Image.alpha_composite(img, glow)
        draw = ImageDraw.Draw(img)

    # Draw ghost onto a mask so we can make it semi-transparent and add effects
    ghost_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(ghost_layer)

    gc = (0, 229, 255, ghost_alpha)

    # Head dome
    gd.ellipse([cx - head_r, ghost_top, cx + head_r, ghost_top + head_r * 2], fill=gc)

    # Body
    body_top = ghost_top + head_r
    gd.rectangle([cx - ghost_width, body_top, cx + ghost_width, ghost_bottom], fill=gc)

    # Wavy bottom - smooth scallops using overlapping circles
    num_scallops = 4
    scallop_w = (ghost_width * 2) / num_scallops
    scallop_r = scallop_w / 2
    for i in range(num_scallops):
        scx = cx - ghost_width + scallop_w * i + scallop_w / 2
        gd.ellipse([
            int(scx - scallop_r), int(ghost_bottom - scallop_r * 0.3),
            int(scx + scallop_r), int(ghost_bottom + scallop_r * 1.2)
        ], fill=gc)

    # Cut away between scallops with background color
    for i in range(num_scallops - 1):
        cut_x = cx - ghost_width + scallop_w * (i + 1)
        cut_r = int(scallop_r * 0.5)
        gd.ellipse([
            int(cut_x - cut_r), int(ghost_bottom + int(2*s)),
            int(cut_x + cut_r), int(ghost_bottom + cut_r * 2.2)
        ], fill=(0, 0, 0, 0))

    # Eyes - block cursor style (proportioned to compact ghost)
    eye_y = ghost_top + int(head_r * 0.75)
    eye_w = int(8 * s)
    eye_h = int(10 * s)
    eye_gap = int(10 * s)

    for ex in [cx - eye_gap - eye_w, cx + eye_gap]:
        # Dark eye socket
        gd.rectangle([ex, eye_y, ex + eye_w, eye_y + eye_h], fill=bg)
        # Bright pupil dot
        dot_r = max(1, int(2 * s))
        dot_cx = ex + eye_w // 2
        dot_cy = eye_y + eye_h // 2
        gd.ellipse([dot_cx - dot_r, dot_cy - dot_r, dot_cx + dot_r, dot_cy + dot_r],
                    fill=(0, 229, 255, 240))

    # Horizontal scan lines across ghost body for digital effect
    if size >= 64:
        for y in range(ghost_top, ghost_bottom + int(scallop_r), max(2, int(4 * s))):
            gd.line([(cx - head_r - int(5*s), y), (cx + head_r + int(5*s), y)],
                     fill=(10, 14, 20, 18), width=1)

    img = Image.alpha_composite(img, ghost_layer)
    draw = ImageDraw.Draw(img)

    # Digital rain in background (faint, behind everything except bg)
    if size >= 64:
        chars = "01アウカキク>_{}"
        font_size = max(8, int(9 * s))
        try:
            font = ImageFont.truetype("consola.ttf", font_size)
        except:
            font = ImageFont.load_default()

        for _ in range(int(12 * s)):
            rx = random.randint(int(10*s), size - int(18*s))
            ry = random.randint(int(10*s), size - int(18*s))
            ch = random.choice(chars)
            alpha = random.randint(20, 50)
            draw.text((rx, ry), ch, fill=(0, 229, 255, alpha), font=font)

    # Terminal prompt at bottom
    if size >= 32:
        prompt_size = max(10, int(14 * s))
        try:
            pfont = ImageFont.truetype("consola.ttf", prompt_size)
        except:
            pfont = ImageFont.load_default()
        prompt_y = size - int(30 * s)
        prompt_text = ">_"
        bbox = pfont.getbbox(prompt_text)
        tw = bbox[2] - bbox[0]
        draw.text((cx - tw // 2, prompt_y), prompt_text, fill=(0, 229, 255, 200), font=pfont)

    return img


def save_ico_highres(images, path):
    """Write .ico with PNG entries, supporting sizes > 256x256."""
    png_blobs = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        png_blobs.append(buf.getvalue())

    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)  # reserved, type=ICO, count
    dir_size = 16 * count
    data_offset = 6 + dir_size

    directory = b""
    offset = data_offset
    for img, blob in zip(images, png_blobs):
        w = img.width if img.width < 256 else 0   # 0 means 256+ (read PNG header)
        h = img.height if img.height < 256 else 0
        directory += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)

    with open(path, "wb") as f:
        f.write(header + directory + b"".join(png_blobs))


hi_res = draw_icon(1024)
sizes = [512, 256, 128, 64, 48, 32, 16]
images = [hi_res.resize((s, s), Image.LANCZOS) for s in sizes]

ico_path = "public/icon.ico"
save_ico_highres(images, ico_path)
png_icon = hi_res.resize((512, 512), Image.LANCZOS)
png_icon.save("public/icon.png", format="PNG")

print(f"Saved {ico_path} with sizes: {sizes}")
print(f"Saved public/icon.png (512x512, downscaled from 1024)")
