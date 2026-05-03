"""One-time migration: pull the four published Google Sheet CSVs into data/*.json.

After running this, data/ becomes the source of truth. The admin sidecar reads
and writes these files; the app prefers them over the live Sheet feeds.
"""
import csv
import io
import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"

FEEDS = {
    "openings": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=0&single=true&output=csv",
    "lines": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=10969022&single=true&output=csv",
    "nodes": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=1261107814&single=true&output=csv",
    "mistake_templates": "https://docs.google.com/spreadsheets/d/e/2PACX-1vQNmZYrVE9U7BynLzoijjgIVSd6Mm2zP_blPqogiQ8zcmvFz4LJi7ADUiM6vdbyc1HZ9oHMBhUR4AHT/pub?gid=1251282566&single=true&output=csv",
}


def fetch_csv(url):
    response = requests.get(url, timeout=40)
    response.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(response.text)))
    for row in rows:
        for key, value in list(row.items()):
            if value is None:
                row[key] = ""
            else:
                row[key] = str(value)
    return rows


def write_json(name, rows):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = DATA_DIR / f"{name}.json"
    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def main():
    for name, url in FEEDS.items():
        rows = fetch_csv(url)
        path = write_json(name, rows)
        print(f"+ {name}: {len(rows)} rows -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
