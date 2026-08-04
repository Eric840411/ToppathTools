"""Build eight-frame, fixed-size WebP loops with one motion language per realm."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
REALM_DIR = ROOT / "public" / "themes" / "xianxia" / "realms-v1"
EFFECT_DIR = ROOT / "public" / "themes" / "xianxia" / "effects-v2"
OUTPUT_DIR = ROOT / "public" / "themes" / "xianxia" / "realms-animated-v2"
SIZE = 320
FRAME_COUNT = 8

REALMS = [
    ("qi-refining", "breath", (105, 226, 218)),
    ("foundation", "pillars", (92, 181, 232)),
    ("golden-core", "corona", (240, 194, 73)),
    ("nascent-soul", "soul", (185, 154, 255)),
    ("spirit-transformation", "ascend", (245, 164, 119)),
    ("void-refining", "rift", (139, 116, 255)),
    ("body-integration", "dual", (105, 217, 178)),
    ("mahayana", "wheel", (247, 219, 133)),
    ("tribulation", "lightning", (168, 143, 255)),
]


def fit(image: Image.Image, size: int) -> Image.Image:
    image = image.convert("RGBA")
    image.thumbnail((size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))
    return canvas


def opacity(image: Image.Image, value: float) -> Image.Image:
    result = image.copy()
    result.putalpha(result.getchannel("A").point(lambda alpha: round(alpha * max(0, min(1, value)))))
    return result


def translate(image: Image.Image, x: int = 0, y: int = 0) -> Image.Image:
    result = Image.new("RGBA", image.size, (0, 0, 0, 0))
    result.alpha_composite(image, (x, y))
    return result


def sector(image: Image.Image, start: float, width: float) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.pieslice((8, 8, SIZE - 8, SIZE - 8), start=start, end=start + width, fill=255)
    result = image.copy()
    result.putalpha(ImageChops.multiply(image.getchannel("A"), mask))
    return result


def fixed_glow(color: tuple[int, int, int], alpha: int, radius: int = 34) -> Image.Image:
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    center = SIZE // 2
    draw.ellipse((center - radius, center - radius, center + radius, center + radius), fill=(*color, alpha))
    return layer.filter(ImageFilter.GaussianBlur(19))


def effect_frame(effect: Image.Image, mode: str, frame_index: int, color: tuple[int, int, int]) -> Image.Image:
    phase = 2 * math.pi * frame_index / FRAME_COUNT
    layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    if mode == "breath":
        # Three qi streams circulate; the medallion itself never moves.
        layer.alpha_composite(opacity(effect.rotate(frame_index * 45, Image.Resampling.BICUBIC), 0.52))
    elif mode == "pillars":
        # The four foundation pillars light in cardinal order.
        layer.alpha_composite(opacity(effect, 0.22))
        pillar_strength = 0.64 if frame_index % 2 == 0 else 0.96
        layer.alpha_composite(opacity(sector(effect, -112.5 + (frame_index // 2) * 90, 55), pillar_strength))
    elif mode == "corona":
        # Golden fire brightens and dims around a completely fixed core.
        glow = 0.42 + 0.32 * (0.5 + 0.5 * math.sin(phase))
        layer.alpha_composite(opacity(effect, glow))
        layer.alpha_composite(fixed_glow(color, round(34 + 32 * (0.5 + 0.5 * math.sin(phase))), 31))
    elif mode == "soul":
        # Spirit pearls rise gently inside the soul cocoon.
        layer.alpha_composite(opacity(translate(effect, y=round(-3 + 3 * math.sin(phase))), 0.52))
        layer.alpha_composite(fixed_glow(color, round(25 + 18 * (0.5 + 0.5 * math.sin(phase))), 29))
    elif mode == "ascend":
        # Five spirit-flame ribbons move only upward inside the fixed frame.
        y = round(-5 + 5 * math.sin(phase))
        layer.alpha_composite(opacity(translate(effect, y=y), 0.58))
        layer.alpha_composite(opacity(translate(effect, y=y + 7), 0.14))
    elif mode == "rift":
        # The asymmetric void rift and fragments orbit as one spatial current.
        layer.alpha_composite(opacity(effect.rotate(-frame_index * 45, Image.Resampling.BICUBIC), 0.56))
    elif mode == "dual":
        # Emerald and gold streams weave back and forth without resizing.
        angle = 4 * math.sin(phase)
        layer.alpha_composite(opacity(effect.rotate(angle, Image.Resampling.BICUBIC), 0.57))
    elif mode == "wheel":
        # The sacred wheel advances one spoke per frame.
        layer.alpha_composite(opacity(effect.rotate(frame_index * 45, Image.Resampling.BICUBIC), 0.48))
    elif mode == "lightning":
        # One heavenly sector flashes at a time; no smooth ring motion.
        layer.alpha_composite(opacity(effect, 0.16))
        layer.alpha_composite(opacity(sector(effect, -112.5 + frame_index * 45, 50), 0.98))
        flash = 30 if frame_index in {1, 4, 7} else 10
        layer.alpha_composite(fixed_glow(color, flash, 28))

    return layer


def build_animation(name: str, mode: str, color: tuple[int, int, int]) -> Path:
    # Both layers are prepared once. Their dimensions remain identical in every frame.
    base = fit(Image.open(REALM_DIR / f"{name}.png"), 300)
    fixed_base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    fixed_base.alpha_composite(base, ((SIZE - base.width) // 2, (SIZE - base.height) // 2))
    effect = fit(Image.open(EFFECT_DIR / f"{name}.png"), SIZE)
    frames: list[Image.Image] = []

    for frame_index in range(FRAME_COUNT):
        frame = fixed_base.copy()
        frame.alpha_composite(effect_frame(effect, mode, frame_index, color))
        frames.append(frame)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output = OUTPUT_DIR / f"{name}.webp"
    frames[0].save(
        output,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=[180] * FRAME_COUNT,
        loop=0,
        quality=84,
        method=4,
        minimize_size=True,
    )
    return output


def main() -> None:
    for realm in REALMS:
        output = build_animation(*realm)
        with Image.open(output) as image:
            print(f"{output.name}: {image.n_frames} fixed 320x320 frames, {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
