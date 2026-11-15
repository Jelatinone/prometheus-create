"""Regenerate the synthetic capture test images in this folder.

    python fixtures/capture/make_fixtures.py

These are generated test patterns (fixtures), not real captures. Each image is
a grey field with a red block in the top-left corner and a blue block on the
right edge of the *stored* pixels, so a missed or doubled rotation is visible.
"""
from pathlib import Path

from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent


def pattern(width: int, height: int) -> Image.Image:
    img = Image.new("RGB", (width, height), (128, 128, 128))
    img.paste((220, 40, 40), (0, 0, width // 4, height // 4))
    img.paste((40, 60, 220), (width - width // 8, height // 3, width, 2 * height // 3))
    return img


def main() -> None:
    upright = pattern(64, 48)
    upright.save(HERE / "upright-64x48.png", optimize=True)
    upright.save(HERE / "upright-64x48.jpg", quality=90)
    upright.save(HERE / "lossy-64x48.webp", quality=80)
    upright.save(HERE / "lossless-64x48.webp", lossless=True)

    # Stored 64x48 with EXIF Orientation=6 ("rotate 90 CW to display"): displayed 48x64.
    exif = Image.Exif()
    exif[0x0112] = 6
    upright.save(HERE / "rotated-orientation6.jpg", quality=90, exif=exif.tobytes())

    # What an orientation-normalizing encoder must produce for it: upright 48x64.
    with Image.open(HERE / "rotated-orientation6.jpg") as rotated:
        ImageOps.exif_transpose(rotated).save(HERE / "rotated-orientation6.upright.png", optimize=True)

    print("wrote", sorted(p.name for p in HERE.iterdir() if p.suffix in {".png", ".jpg", ".webp"}))


if __name__ == "__main__":
    main()
