from __future__ import annotations

import io
import re
import urllib.request
from pathlib import Path

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_URL = "https://tapujemy.pl/gifts"
SHEET_ROOT = PROJECT_ROOT / "assets" / "generated" / "tiktok-gifts"
ICON_ROOT = PROJECT_ROOT / "apps" / "admin" / "public" / "gifts"
OVERLAY_ICON_ROOT = PROJECT_ROOT / "apps" / "overlay" / "public" / "gifts"
TILE_SIZE = 256
SHEET_COLUMNS = 6
SHEET_ROWS = 4

# Thirteen gifts were captured by this installation through TikFinity. One
# region-only pass gift is intentionally excluded because the current platform
# catalog does not expose a verifiable icon. The remaining entries provide a
# representative 1-5000 coin range. Prices are checked before files are written.
EXPECTED_COINS: dict[str, int] = {
    "5269": 1, "5655": 1, "5827": 1, "6064": 1,
    "6093": 1, "6246": 1, "6247": 1, "6788": 1,
    "6890": 1, "7934": 1, "15231": 1,
    "5487": 5, "14786": 5,
    "5480": 10, "9947": 10,
    "5658": 20, "5879": 30,
    "5659": 99, "6427": 99, "12678": 99, "13087": 99, "14109": 99,
    "5585": 100, "5660": 100,
    "17359": 149, "5586": 199,
    "15191": 249, "15763": 249, "17985": 249,
    "6007": 299, "6267": 299, "8914": 399, "5731": 499,
    "7168": 500, "9948": 500, "5897": 699, "5978": 899,
    "11046": 1000, "14397": 1000, "6090": 1088,
    "7467": 1500, "6862": 1999, "17762": 2999, "6563": 3000,
    "5767": 4888, "6646": 4888, "14769": 4999, "9500": 5000,
}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def parse_catalog(html: str) -> dict[str, dict[str, str | int]]:
    catalog: dict[str, dict[str, str | int]] = {}
    for card in html.split('<div class="gift-card">')[1:]:
        image = re.search(r'<img src="([^"]+)" alt="([^"]*)">', card)
        gift_id = re.search(r'#(\d+)', card)
        price = re.search(r'gift-price[\s\S]{0,300}?([0-9][0-9.,]*)', card)
        if not image or not gift_id or not price:
            continue
        catalog[gift_id.group(1)] = {
            "icon": image.group(1),
            "sourceName": image.group(2),
            "coins": int(price.group(1).replace(",", "").replace(".", "")),
        }
    return catalog


def fit_icon(raw: bytes) -> Image.Image:
    with Image.open(io.BytesIO(raw)) as source:
        icon = source.convert("RGBA")
    icon.thumbnail((208, 208), Image.Resampling.LANCZOS)
    tile = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
    tile.alpha_composite(icon, ((TILE_SIZE - icon.width) // 2, (TILE_SIZE - icon.height) // 2))
    return tile


def main() -> None:
    html = fetch(SOURCE_URL).decode("utf-8")
    catalog = parse_catalog(html)
    missing = [gift_id for gift_id in EXPECTED_COINS if gift_id not in catalog]
    mismatched = [
        f"{gift_id}: expected {coins}, got {catalog[gift_id]['coins']}"
        for gift_id, coins in EXPECTED_COINS.items()
        if gift_id in catalog and catalog[gift_id]["coins"] != coins
    ]
    if missing or mismatched:
        raise RuntimeError(f"Catalog verification failed; missing={missing}; mismatched={mismatched}")

    SHEET_ROOT.mkdir(parents=True, exist_ok=True)
    ICON_ROOT.mkdir(parents=True, exist_ok=True)
    OVERLAY_ICON_ROOT.mkdir(parents=True, exist_ok=True)
    gift_ids = list(EXPECTED_COINS)
    tiles = {gift_id: fit_icon(fetch(str(catalog[gift_id]["icon"]))) for gift_id in gift_ids}

    for sheet_index in range((len(gift_ids) + 23) // 24):
        sheet = Image.new(
            "RGBA",
            (SHEET_COLUMNS * TILE_SIZE, SHEET_ROWS * TILE_SIZE),
            (0, 0, 0, 0),
        )
        sheet_ids = gift_ids[sheet_index * 24:(sheet_index + 1) * 24]
        for position, gift_id in enumerate(sheet_ids):
            x = (position % SHEET_COLUMNS) * TILE_SIZE
            y = (position // SHEET_COLUMNS) * TILE_SIZE
            sheet.alpha_composite(tiles[gift_id], (x, y))
        sheet_path = SHEET_ROOT / f"tiktok-gifts-sheet-{sheet_index + 1:02d}.png"
        sheet.save(sheet_path, optimize=True)

        # The production icons are deliberately cut back out of the verified
        # 24-cell sheet, matching the operator's requested workflow.
        for position, gift_id in enumerate(sheet_ids):
            x = (position % SHEET_COLUMNS) * TILE_SIZE
            y = (position // SHEET_COLUMNS) * TILE_SIZE
            crop = sheet.crop((x, y, x + TILE_SIZE, y + TILE_SIZE))
            crop.save(ICON_ROOT / f"{gift_id}.png", optimize=True)
            crop.save(OVERLAY_ICON_ROOT / f"{gift_id}.png", optimize=True)

    print(f"verified={len(gift_ids)} sheets={(len(gift_ids) + 23) // 24} icons={len(list(ICON_ROOT.glob('*.png')))}")


if __name__ == "__main__":
    main()
