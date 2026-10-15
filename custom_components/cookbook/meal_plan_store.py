"""Persistent store for the weekly recipe calendar (feature-10).

Owns a single versioned JSON document with the household meal plan and the
global slot configuration. The card never touches the file directly; it goes
through the ``cookbook.*`` meal-plan services which delegate here.

Document shape::

    {
      "version": 1,
      "slots": [
        {"id": "meal", "kind": "builtin", "enabled": true},
        {"id": "family-dinner", "kind": "custom", "name": "Familienessen",
         "enabled": true}
      ],
      "entries": [
        {"id": "<uuid>", "date": "2026-09-07", "slot_id": "meal",
         "recipe_id": "12"}
      ]
    }

Design rules (see docs/planings/in-progress/feature-10-weekly-recipe-calendar):

- Entries are independent records with a stable UUID, local ``YYYY-MM-DD``
  ``date``, ``slot_id`` and ``recipe_id``. A recipe may be planned any number
  of times; there is no duplicate rejection.
- Built-in slots have stable IDs and localized labels (labels live in the card,
  not here). They can be enabled/disabled and reordered but never renamed or
  deleted. Only ``meal`` is enabled by default.
- Custom slots carry a user name and a stable slug id. Names must be non-empty
  and unique case-insensitively across all slots.
- Deleting a custom slot remaps its entries to ``meal`` when ``meal`` is
  enabled, otherwise to the temporary ``unassigned`` slot.
- Writes are atomic (temp file + replace) and guarded by an async lock.

All disk I/O is done through ``anyio.to_thread`` so the store is a drop-in peer
of ``RecipeStore`` in the async Home Assistant runtime.
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

import anyio

VERSION = 1

# Built-in slot ids in their default order. Labels are localized in the card.
BUILTIN_SLOT_IDS: tuple[str, ...] = (
    "meal",
    "breakfast",
    "lunch",
    "dinner",
    "snack",
    "dessert",
    "side",
)

# Slots enabled by default (decision: only the general meal slot).
DEFAULT_ENABLED_SLOT_IDS: frozenset[str] = frozenset({"meal"})

# Temporary system slot used when a custom slot with entries is deleted while
# ``meal`` is disabled. It is never persisted as a configurable slot; the card
# renders it only while it holds entries.
UNASSIGNED_SLOT_ID = "unassigned"

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SlotValidationError(Exception):
    """Raised for invalid slot operations (bad name, duplicate, builtin delete)."""


class EntryValidationError(Exception):
    """Raised for invalid plan entries (bad date, unknown slot, missing entry)."""


def _slugify(name: str) -> str:
    """Derive a stable, url-safe slot id from a display name."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "slot"


def _is_valid_date(value: object) -> bool:
    if not isinstance(value, str) or not _DATE_RE.match(value):
        return False
    year, month, day = (int(part) for part in value.split("-"))
    if not 1 <= month <= 12:
        return False
    days_in_month = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    if month == 2 and not (year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)):
        days_in_month = 28
    return 1 <= day <= days_in_month


def _default_document() -> dict[str, object]:
    slots = [
        {"id": slot_id, "kind": "builtin", "enabled": slot_id in DEFAULT_ENABLED_SLOT_IDS}
        for slot_id in BUILTIN_SLOT_IDS
    ]
    return {"version": VERSION, "slots": slots, "entries": []}


class MealPlanStore:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._lock = anyio.Lock()

    # -- public reads -------------------------------------------------------

    async def get_plan(self) -> dict[str, object]:
        return await anyio.to_thread.run_sync(self._read)

    # -- entry mutations ----------------------------------------------------

    async def add_entry(
        self, *, date: str, slot_id: str, recipe_id: str = "", text: str = ""
    ) -> dict[str, object]:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            self._require_valid_date(date)
            self._require_known_slot(document, slot_id)
            resolved_recipe = str(recipe_id or "")
            resolved_text = str(text or "").strip()
            self._require_recipe_or_text(resolved_recipe, resolved_text)
            entry = {
                "id": uuid.uuid4().hex,
                "date": date,
                "slot_id": slot_id,
                "recipe_id": resolved_recipe,
                "text": resolved_text,
            }
            document["entries"].append(entry)
            await anyio.to_thread.run_sync(self._write, document)
            return entry

    async def update_entry(
        self, entry_id: str, *, date: str, slot_id: str, recipe_id: str = "", text: str = ""
    ) -> dict[str, object]:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            self._require_valid_date(date)
            self._require_known_slot(document, slot_id)
            entry = self._find_entry(document, entry_id)
            if entry is None:
                raise EntryValidationError(f"Unknown plan entry: {entry_id}")
            resolved_recipe = str(recipe_id or "")
            resolved_text = str(text or "").strip()
            self._require_recipe_or_text(resolved_recipe, resolved_text)
            entry["date"] = date
            entry["slot_id"] = slot_id
            entry["recipe_id"] = resolved_recipe
            entry["text"] = resolved_text
            await anyio.to_thread.run_sync(self._write, document)
            return entry

    async def delete_entry(self, entry_id: str) -> bool:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            before = len(document["entries"])
            document["entries"] = [e for e in document["entries"] if e["id"] != entry_id]
            removed = len(document["entries"]) != before
            if removed:
                await anyio.to_thread.run_sync(self._write, document)
            return removed

    # -- slot configuration -------------------------------------------------

    async def add_custom_slot(self, name: str) -> dict[str, object]:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            clean = name.strip()
            if not clean:
                raise SlotValidationError("Slot name must not be empty.")
            self._require_unique_name(document, clean)
            slot_id = self._unique_slug(document, _slugify(clean))
            slot = {"id": slot_id, "kind": "custom", "name": clean, "enabled": True}
            document["slots"].append(slot)
            await anyio.to_thread.run_sync(self._write, document)
            return slot

    async def rename_slot(self, slot_id: str, name: str) -> dict[str, object]:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            slot = self._find_slot(document, slot_id)
            if slot is None:
                raise SlotValidationError(f"Unknown slot: {slot_id}")
            if slot["kind"] != "custom":
                raise SlotValidationError("Built-in slots cannot be renamed.")
            clean = name.strip()
            if not clean:
                raise SlotValidationError("Slot name must not be empty.")
            self._require_unique_name(document, clean, ignore_id=slot_id)
            slot["name"] = clean
            await anyio.to_thread.run_sync(self._write, document)
            return slot

    async def delete_slot(self, slot_id: str) -> dict[str, object]:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            slot = self._find_slot(document, slot_id)
            if slot is None:
                raise SlotValidationError(f"Unknown slot: {slot_id}")
            if slot["kind"] != "custom":
                raise SlotValidationError("Built-in slots cannot be deleted.")
            target = self._remap_target(document)
            for entry in document["entries"]:
                if entry["slot_id"] == slot_id:
                    entry["slot_id"] = target
            document["slots"] = [s for s in document["slots"] if s["id"] != slot_id]
            await anyio.to_thread.run_sync(self._write, document)
            return document

    async def set_slot_enabled(self, slot_id: str, enabled: bool) -> dict[str, object]:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            slot = self._find_slot(document, slot_id)
            if slot is None:
                raise SlotValidationError(f"Unknown slot: {slot_id}")
            slot["enabled"] = bool(enabled)
            await anyio.to_thread.run_sync(self._write, document)
            return slot

    async def reorder_slots(self, ordered_ids: list[str]) -> dict[str, object]:
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            by_id = {slot["id"]: slot for slot in document["slots"]}
            unknown = [slot_id for slot_id in ordered_ids if slot_id not in by_id]
            if unknown:
                raise SlotValidationError(f"Unknown slot(s) in order: {unknown}")
            ordered = [by_id[slot_id] for slot_id in ordered_ids]
            remaining = [slot for slot in document["slots"] if slot["id"] not in set(ordered_ids)]
            document["slots"] = ordered + remaining
            await anyio.to_thread.run_sync(self._write, document)
            return document

    async def save_slots(self, slots: list[dict[str, object]]) -> dict[str, object]:
        """Replace the entire slot configuration (used by the card editor).

        Built-in slots are re-normalized (kind fixed, name dropped); custom
        slots keep a validated, unique name and a stable id. Entries pointing
        at removed custom slots are remapped like ``delete_slot``.
        """
        async with self._lock:
            document = await anyio.to_thread.run_sync(self._read)
            normalized = self._normalize_slots(slots)
            kept_ids = {slot["id"] for slot in normalized}
            target = self._remap_target({"slots": normalized})
            for entry in document["entries"]:
                if entry["slot_id"] not in kept_ids and entry["slot_id"] != UNASSIGNED_SLOT_ID:
                    entry["slot_id"] = target
            document["slots"] = normalized
            await anyio.to_thread.run_sync(self._write, document)
            return document

    # -- internals ----------------------------------------------------------

    def _normalize_slots(self, slots: list[dict[str, object]]) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        seen_ids: set[str] = set()
        seen_names: set[str] = set()
        for raw in slots:
            slot_id = str(raw.get("id", "")).strip()
            if slot_id in BUILTIN_SLOT_IDS:
                if slot_id in seen_ids:
                    continue
                result.append(
                    {"id": slot_id, "kind": "builtin", "enabled": bool(raw.get("enabled", False))}
                )
                seen_ids.add(slot_id)
                continue
            name = str(raw.get("name", "")).strip()
            if not name:
                raise SlotValidationError("Custom slot name must not be empty.")
            if name.lower() in seen_names:
                raise SlotValidationError(f"Duplicate slot name: {name}")
            resolved_id = slot_id or self._unique_slug({"slots": result}, _slugify(name))
            if resolved_id in seen_ids:
                resolved_id = self._unique_slug({"slots": result}, resolved_id)
            result.append(
                {"id": resolved_id, "kind": "custom", "name": name, "enabled": bool(raw.get("enabled", True))}
            )
            seen_ids.add(resolved_id)
            seen_names.add(name.lower())
        # ensure built-in slots always exist even if the editor omitted some
        for slot_id in BUILTIN_SLOT_IDS:
            if slot_id not in seen_ids:
                result.append(
                    {
                        "id": slot_id,
                        "kind": "builtin",
                        "enabled": slot_id in DEFAULT_ENABLED_SLOT_IDS,
                    }
                )
                seen_ids.add(slot_id)
        return result

    def _remap_target(self, document: dict[str, object]) -> str:
        meal = self._find_slot(document, "meal")
        if meal is not None and meal.get("enabled"):
            return "meal"
        return UNASSIGNED_SLOT_ID

    @staticmethod
    def _find_slot(document: dict[str, object], slot_id: str) -> dict[str, object] | None:
        for slot in document.get("slots", []):
            if slot["id"] == slot_id:
                return slot
        return None

    @staticmethod
    def _find_entry(document: dict[str, object], entry_id: str) -> dict[str, object] | None:
        for entry in document.get("entries", []):
            if entry["id"] == entry_id:
                return entry
        return None

    @staticmethod
    def _require_valid_date(date: str) -> None:
        if not _is_valid_date(date):
            raise EntryValidationError(f"Invalid date (expected YYYY-MM-DD): {date!r}")

    @staticmethod
    def _require_recipe_or_text(recipe_id: str, text: str) -> None:
        if not recipe_id and not text:
            raise EntryValidationError("A plan entry needs a recipe_id or a text.")

    def _require_known_slot(self, document: dict[str, object], slot_id: str) -> None:
        if slot_id == UNASSIGNED_SLOT_ID:
            return
        if self._find_slot(document, slot_id) is None:
            raise EntryValidationError(f"Unknown slot: {slot_id}")

    @staticmethod
    def _require_unique_name(
        document: dict[str, object], name: str, *, ignore_id: str | None = None
    ) -> None:
        lowered = name.lower()
        for slot in document.get("slots", []):
            if slot.get("id") == ignore_id:
                continue
            existing = str(slot.get("name", slot.get("id", ""))).lower()
            if existing == lowered:
                raise SlotValidationError(f"Duplicate slot name: {name}")

    @staticmethod
    def _unique_slug(document: dict[str, object], base: str) -> str:
        existing = {slot["id"] for slot in document.get("slots", [])}
        if base not in existing:
            return base
        index = 2
        while f"{base}-{index}" in existing:
            index += 1
        return f"{base}-{index}"

    def _read(self) -> dict[str, object]:
        if not self._path.is_file():
            return _default_document()
        try:
            document = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return _default_document()
        if not isinstance(document, dict):
            return _default_document()
        document.setdefault("version", VERSION)
        if not isinstance(document.get("slots"), list) or not document["slots"]:
            document["slots"] = _default_document()["slots"]
        if not isinstance(document.get("entries"), list):
            document["entries"] = []
        # Backfill the optional free-text field on older entries.
        for entry in document["entries"]:
            if isinstance(entry, dict):
                entry.setdefault("text", "")
                entry.setdefault("recipe_id", "")
        return document

    def _write(self, document: dict[str, object]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(self._path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary.replace(self._path)
