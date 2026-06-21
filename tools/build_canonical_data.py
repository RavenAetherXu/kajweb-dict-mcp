#!/usr/bin/env python3
import json
import re
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"


def norm_word(value):
    normalized = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    return re.sub(r"\s+", " ", normalized)


def canonical_word_id(norm):
    slug = re.sub(r"[^a-z0-9]+", "_", norm).strip("_")
    return f"cw_{slug[:80]}" if slug else "cw_empty"


def normalize_translation(value):
    return re.sub(r"\s+", " ", str(value or "").replace("\n", " ").replace("\r", " ")).strip()


def pick_display_word(entries):
    counts = Counter(entry["word"] for entry in entries if entry.get("word"))
    return counts.most_common(1)[0][0] if counts else ""


def pick_primary_translation(entries):
    translations = [normalize_translation(entry.get("translation")) for entry in entries if entry.get("translation")]
    if not translations:
        return ""
    counts = Counter(translations)
    max_count = max(counts.values())
    candidates = [text for text, count in counts.items() if count == max_count]
    return min(candidates, key=len)


def main():
    books = json.loads((DATA / "ielts_books.json").read_text(encoding="utf-8"))
    words = json.loads((DATA / "ielts_words.json").read_text(encoding="utf-8"))
    metadata = json.loads((DATA / "metadata.json").read_text(encoding="utf-8"))

    book_titles = {book["id"]: book["title"] for book in books}
    by_norm = defaultdict(list)
    for entry in words:
        key = norm_word(entry.get("word"))
        if key:
            by_norm[key].append(entry)

    canonical_words = []
    for norm, entries in sorted(by_norm.items()):
        source_books = sorted({entry["bookId"] for entry in entries})
        translations = sorted(
            {normalize_translation(entry.get("translation")) for entry in entries if entry.get("translation")}
        )
        flags = []
        if len(entries) > 1:
            flags.append("source_duplicate")
        if len(translations) > 1:
            flags.append("translation_conflict")

        sources = []
        for entry in sorted(entries, key=lambda item: (item["bookId"], int(item.get("rank") or 0))):
            sources.append(
                {
                    "bookId": entry["bookId"],
                    "bookTitle": book_titles.get(entry["bookId"], ""),
                    "wordId": entry.get("wordId", ""),
                    "rank": entry.get("rank"),
                    "word": entry.get("word", ""),
                    "translation": entry.get("translation", ""),
                }
            )

        canonical_words.append(
            {
                "canonicalWordId": canonical_word_id(norm),
                "word": pick_display_word(entries),
                "normWord": norm,
                "primaryTranslation": pick_primary_translation(entries),
                "translations": translations,
                "sourceBookIds": source_books,
                "sourceBookCount": len(source_books),
                "rowCount": len(entries),
                "qualityFlags": flags,
                "sources": sources,
            }
        )

    metadata.update(
        {
            "rowCount": len(words),
            "wordCount": len(words),
            "uniqueWordCount": len(canonical_words),
            "duplicateWordCount": sum(1 for item in canonical_words if item["rowCount"] > 1),
            "translationConflictCount": sum(
                1 for item in canonical_words if "translation_conflict" in item["qualityFlags"]
            ),
            "canonicalSchemaVersion": 1,
        }
    )

    (DATA / "ielts_canonical_words.json").write_text(
        json.dumps(canonical_words, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (DATA / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "rowCount": len(words),
                "uniqueWordCount": len(canonical_words),
                "duplicateWordCount": metadata["duplicateWordCount"],
                "translationConflictCount": metadata["translationConflictCount"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
