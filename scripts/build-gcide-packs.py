#!/usr/bin/env python3
"""Build GCIDE 0.54 general, medical, and pharmacy packs from the pinned source snapshot.

Usage: python3 scripts/build-gcide-packs.py <extracted-gcide-source-dir>
The source directory must contain CIDE.A through CIDE.Z, INFO, COPYING, and webfont.txt.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import html
import json
import re
import sys
from pathlib import Path

SOURCE_COMMIT = "9fbf5adae3e59c79b1d020d79e99d1d7fd65a5ce"
SOURCE_ARCHIVE_SHA256 = "fd16b06551f57a5d1013b4f2fe447f65006ad8414f37d255251c3f1ea0016abe"
SOURCE_CONTENT_SHA256 = "ab11931f9ccd063bee16e6e2bbe5dce027c2d39d23f527bcb8ea35d1de1468a9"
SOURCE_URL = f"https://codeload.github.com/GitMirroring/gcide/zip/{SOURCE_COMMIT}"
BUILD_DATE = "2026-10-25"
ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "public" / "dictionary-packs"
ARTICLE_START = re.compile(r"<p>\s*<ent>", re.IGNORECASE)
ENTRY_TERM = re.compile(r"<ent>(.*?)</ent>", re.IGNORECASE | re.DOTALL)
DEFINITION = re.compile(r"<def>(.*?)</def>", re.IGNORECASE | re.DOTALL)
FIELD = re.compile(r"<fld>(.*?)</fld>", re.IGNORECASE | re.DOTALL)
PART_OF_SPEECH = re.compile(r"<pos>(.*?)</pos>", re.IGNORECASE | re.DOTALL)
COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
TAG = re.compile(r"<[^>]*>")
ESCAPE = re.compile(r"\\'([0-9a-fA-F]{2})")
MEDICAL_FIELDS = re.compile(
    r"\b(?:med(?:icine|ical)?\.?|anatomy|anat\.?|surg(?:ery)?\.?|pathol(?:ogy)?\.?|"
    r"physiol(?:ogy)?\.?|therap(?:y|eutics)?|veter(?:inary)?\.?|dent(?:istry)?\.?|"
    r"obstet(?:rics)?\.?|pediat(?:rics)?\.?|psychiat(?:ry)?\.?|neurol(?:ogy)?\.?|"
    r"ophthalm(?:ology)?\.?|immunology)\b",
    re.IGNORECASE,
)
PHARMACY_FIELDS = re.compile(r"\b(?:pharm(?:acy|acology|aceutics)?\.?)\b", re.IGNORECASE)

PACKS = (
    {
        "id": "gcide-054",
        "title": "General English — GCIDE 0.54",
        "category": "general",
        "file": "gcide-0.54-v1.yayrapack",
        "description": "Historical English dictionary with 108,000+ headwords, based on Webster's Revised Unabridged Dictionary (1913) with WordNet additions and later volunteer revisions. GPL-3.0-or-later.",
        "selector": None,
    },
    {
        "id": "gcide-medical-054",
        "title": "Medical — GCIDE 0.54 subject-tagged terms",
        "category": "medical",
        "file": "gcide-medical-0.54-v1.yayrapack",
        "description": "Historical medical and anatomy entries explicitly tagged in GCIDE 0.54. Not current clinical guidance or medical advice.",
        "selector": MEDICAL_FIELDS,
    },
    {
        "id": "gcide-pharmacy-054",
        "title": "Pharmacy — GCIDE 0.54 subject-tagged terms",
        "category": "pharmacy",
        "file": "gcide-pharmacy-0.54-v1.yayrapack",
        "description": "A small historical set of entries explicitly tagged Pharmacy or Pharmacology in GCIDE 0.54; not a current drug database, formulary, or prescribing guide.",
        "selector": PHARMACY_FIELDS,
    },
)


def clean_markup(value: str, escape_map: dict[str, str]) -> str:
    value = html.unescape(value)
    value = ESCAPE.sub(lambda match: escape_map.get(match.group(1).lower(), ""), value)
    value = value.replace("<mdash/", "—").replace("<ndash/", "–").replace("<dag/", "†")
    value = value.replace("<ddag/", "‡").replace("<par/", "‖").replace("<deg/", "°")
    value = TAG.sub(" ", value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def read_escape_map(webfont_path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    # The upstream table maps legacy MICRA font byte values to Unicode.
    row = re.compile(r"^\s*\d{1,3}\s+([0-9a-fA-F]{2})\s+(\S)\s+")
    for line in webfont_path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = row.match(line)
        if match:
            result[match.group(1).lower()] = match.group(2)
    return result


def parse_sources(source_root: Path) -> list[dict]:
    info = (source_root / "INFO").read_text(encoding="utf-8", errors="replace")
    copying = (source_root / "COPYING").read_text(encoding="utf-8", errors="replace")
    if "version 0.54" not in info or "GNU General Public License" not in info:
        raise SystemExit("The pinned source must identify itself as GCIDE 0.54 under GPL-3.0-or-later.")
    if "GNU GENERAL PUBLIC LICENSE" not in copying or "Version 3, 29 June 2007" not in copying:
        raise SystemExit("GCIDE's complete GPL-3 license text is missing or unexpected.")

    escape_map = read_escape_map(source_root / "webfont.txt")
    articles: list[dict] = []
    for source_file in sorted(source_root.glob("CIDE.*")):
        content = source_file.read_text(encoding="utf-8", errors="replace")
        content = COMMENT.sub(" ", content)
        starts = list(ARTICLE_START.finditer(content))
        for index, start in enumerate(starts):
            end = starts[index + 1].start() if index + 1 < len(starts) else len(content)
            article = content[start.start():end]
            terms = list(dict.fromkeys(
                term for term in (clean_markup(match.group(1), escape_map) for match in ENTRY_TERM.finditer(article))
                if term and re.search(r"[\w\u0080-\uffff]", term)
            ))
            if not terms:
                continue
            fields = [clean_markup(match.group(1), escape_map) for match in FIELD.finditer(article)]
            raw_definitions = [clean_markup(match.group(1), escape_map) for match in DEFINITION.finditer(article)]
            definitions = [text for text in raw_definitions if text]
            if not definitions:
                continue
            pos_matches = [clean_markup(match.group(1), escape_map) for match in PART_OF_SPEECH.finditer(article)]
            pos = pos_matches[0].lower() if pos_matches else ""
            # Preserve the source's useful grammatical distinction without
            # copying abbreviation punctuation into the normalized field.
            part_of_speech = "verb" if re.search(r"\bv\b", pos) else "noun" if re.search(r"\bn\b", pos) else ""
            articles.append({"terms": terms, "fields": fields, "definitions": definitions[:30], "partOfSpeech": part_of_speech})
    if len(articles) < 100_000:
        raise SystemExit(f"Unexpectedly few GCIDE articles parsed ({len(articles)}); source markup may have changed.")
    return articles


def build_entries(articles: list[dict], selector: re.Pattern | None) -> list[dict]:
    by_term: dict[str, dict] = {}
    for article in articles:
        if selector and not any(selector.search(field) for field in article["fields"]):
            continue
        for term in article["terms"]:
            normalized = re.sub(r"\s+", " ", term).strip().casefold()
            if not normalized:
                continue
            entry = by_term.setdefault(normalized, {"term": term, "definitions": [], "_seen": set()})
            for text in article["definitions"]:
                key = (article["partOfSpeech"], text)
                if key in entry["_seen"] or len(entry["definitions"]) >= 30:
                    continue
                entry["_seen"].add(key)
                definition = {"text": text}
                if article["partOfSpeech"]:
                    definition["partOfSpeech"] = article["partOfSpeech"]
                entry["definitions"].append(definition)
    entries = [
        {"term": item["term"], "definitions": item["definitions"]}
        for item in by_term.values() if item["definitions"]
    ]
    return sorted(entries, key=lambda item: (item["term"].casefold(), item["term"]))


def write_pack(pack: dict, entries: list[dict], license_text: str, info: str) -> dict:
    if not entries or len(entries) > 200_000:
        raise SystemExit(f"Unexpected GCIDE pack entry count for {pack['id']}: {len(entries)}")
    metadata = {
        "id": pack["id"],
        "title": pack["title"],
        "category": pack["category"],
        "version": "0.54.0",
        "datasetVersion": "0.54",
        "packVersion": "1.0.0",
        "source": f"GCIDE 0.54 source files at pinned GitHub mirror commit {SOURCE_COMMIT}; the release identifies Webster 1913 material, WordNet additions, and later volunteer revisions.",
        "sourceUrl": SOURCE_URL,
        "sourceIntegrity": f"sha256-{base64.b64encode(bytes.fromhex(SOURCE_ARCHIVE_SHA256)).decode('ascii')}",
        "license": "GNU General Public License version 3 or (at your option) any later version (GPL-3.0-or-later).",
        "licenseText": license_text,
        "attribution": "GCIDE copyright 1992–2021 Patrick J. Cassidy; 2012–2024 Sergey Poznyakoff; other contributors. The source describes the corpus as based on Webster's Revised Unabridged Dictionary (1913) with WordNet additions. Full notices and GPL text are included.",
        "buildDate": BUILD_DATE,
        "updatedAt": BUILD_DATE,
        "description": pack["description"],
        "sourceNotes": info.strip(),
    }
    raw = json.dumps({"format": "yayra-dictionary-pack", "formatVersion": 1, "metadata": metadata, "entries": entries}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    out = OUTPUT_DIR / pack["file"]
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as target:
        with gzip.GzipFile(fileobj=target, mode="wb", compresslevel=9, mtime=0) as compressed:
            compressed.write(raw)
    payload = out.read_bytes()
    return {
        "id": pack["id"], "output": str(out.relative_to(ROOT)), "entries": len(entries),
        "jsonBytes": len(raw), "gzipBytes": len(payload),
        "integrity": "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode("ascii"),
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/build-gcide-packs.py <extracted-gcide-source-dir>")
    source_root = Path(sys.argv[1]).resolve()
    expected_files = [*(source_root / f"CIDE.{letter}" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), source_root / "INFO", source_root / "COPYING", source_root / "webfont.txt"]
    if not source_root.is_dir() or not all(path.is_file() for path in expected_files):
        raise SystemExit("Source directory is incomplete; expected all CIDE.A–CIDE.Z files, INFO, COPYING, and webfont.txt.")
    digest = hashlib.sha256()
    source_files = sorted([*(f"CIDE.{letter}" for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "INFO", "COPYING", "webfont.txt"])
    for relative in source_files:
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update((source_root / relative).read_bytes())
        digest.update(b"\0")
    if digest.hexdigest() != SOURCE_CONTENT_SHA256:
        raise SystemExit("GCIDE source files do not match the pinned 0.54 snapshot content digest.")
    articles = parse_sources(source_root)
    info = (source_root / "INFO").read_text(encoding="utf-8", errors="replace")
    copying = (source_root / "COPYING").read_text(encoding="utf-8", errors="replace")
    license_text = f"GCIDE 0.54 source distribution information:\n\n{info.strip()}\n\n---\n\nComplete GPL license text from the upstream COPYING file:\n\n{copying.strip()}"
    if len(license_text) > 50_000:
        raise SystemExit(f"License text exceeds the app's 50,000 character storage limit ({len(license_text)}).")
    public_copy = license_text.replace("\r\n", "\n").replace("\r", "\n")
    (OUTPUT_DIR / "GCIDE-LICENSE-0.54.md").write_text(public_copy + "\n", encoding="utf-8")
    summaries = []
    for pack in PACKS:
        entries = build_entries(articles, pack["selector"])
        summaries.append(write_pack(pack, entries, license_text, info))
    print(json.dumps({"sourceCommit": SOURCE_COMMIT, "sourceArchiveIntegrity": f"sha256-{SOURCE_ARCHIVE_SHA256}", "sourceArticles": len(articles), "packs": summaries}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
