from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
BASE_SIZE = 512
ICON_DIR = Path(__file__).resolve().parents[1] / "assets" / "icons"
BASE_START = (0xDD, 0x77, 0x42, 255)
BASE_END = (0x94, 0x35, 0x1D, 255)
DOT_RING = (0xFF, 0xFA, 0xF2, 255)
SYMBOL = (0xFF, 0xFD, 0xF7, 255)
STATE_COLORS = {
    "running": (0x2F, 0xA7, 0x6D, 255),
    "starting": (0xD3, 0x9B, 0x22, 255),
    "restarting": (0xC9, 0x7A, 0x10, 255),
    "error": (0xD6, 0x45, 0x45, 255),
    "stopped": (0x7F, 0x8C, 0x8D, 255),
}


def lerp(a: int, b: int, t: float) -> int:
    return int(round(a + (b - a) * t))


def create_gradient_square(size: int) -> Image.Image:
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / max(1, (size - 1) * 2)
            pixels[x, y] = tuple(lerp(BASE_START[i], BASE_END[i], t) for i in range(4))
    return image


def build_icon(state: str | None = None) -> Image.Image:
    canvas = Image.new("RGBA", (BASE_SIZE, BASE_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    outer_margin = 34
    tile = create_gradient_square(BASE_SIZE - outer_margin * 2)
    mask = Image.new("L", tile.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, tile.size[0] - 1, tile.size[1] - 1),
        radius=150,
        fill=255,
    )
    canvas.paste(tile, (outer_margin, outer_margin), mask)

    outer_diamond = [(256, 74), (438, 256), (256, 438), (74, 256)]
    inner_diamond = [(256, 158), (354, 256), (256, 354), (158, 256)]
    draw.polygon(outer_diamond, fill=SYMBOL)
    draw.polygon(inner_diamond, fill=(0, 0, 0, 0))

    cutout = create_gradient_square(BASE_SIZE)
    cutout_mask = Image.new("L", (BASE_SIZE, BASE_SIZE), 0)
    ImageDraw.Draw(cutout_mask).polygon(inner_diamond, fill=255)
    canvas.paste(cutout, (0, 0), cutout_mask)

    if state is not None:
        cx, cy = 404, 404
        draw.ellipse((cx - 74, cy - 74, cx + 74, cy + 74), fill=DOT_RING)
        draw.ellipse((cx - 50, cy - 50, cx + 50, cy + 50), fill=STATE_COLORS[state])

    return canvas


def save_ico(image: Image.Image, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(output_path, format="ICO", sizes=[(size, size) for size in SIZES])


def main() -> None:
    save_ico(build_icon(None), ICON_DIR / "app.ico")
    for state in STATE_COLORS:
        save_ico(build_icon(state), ICON_DIR / f"tray-{state}.ico")


if __name__ == "__main__":
    main()
