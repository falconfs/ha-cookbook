"""Tests for the meal-plan store (feature-10 weekly recipe calendar).

The weekly calendar persists a household meal plan plus a global slot
configuration in a single versioned JSON document at
``/config/cookbook/meal_plan.json``. The card never touches this file directly;
it goes through the integration services which delegate to ``MealPlanStore``.

Design contract validated here:

- one versioned document ``{"version": int, "slots": [...], "entries": [...]}``
- entries are independent records with a stable UUID, local ``YYYY-MM-DD``
  ``date``, ``slot_id`` and ``recipe_id``
- a recipe may be planned any number of times (no duplicate rejection)
- add/update/delete operate on a single entry by id
- writes are atomic (temp file + replace) and guarded by an async lock
- deleting a custom slot remaps its entries to ``meal`` when that slot is
  active, otherwise to the temporary ``unassigned`` slot
- built-in slots cannot be deleted; custom slot names must be unique
  (case-insensitive) and non-empty

Run with:
    python3 -m pytest \
        integration/custom_components/cookbook/test_meal_plan_store.py
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "meal_plan_store.py"
_spec = importlib.util.spec_from_file_location("cookbook_meal_plan_store", _MODULE_PATH)
assert _spec and _spec.loader
meal_plan_store = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(meal_plan_store)

MealPlanStore = meal_plan_store.MealPlanStore
SlotValidationError = meal_plan_store.SlotValidationError
EntryValidationError = meal_plan_store.EntryValidationError


def _run(coro):
    return asyncio.run(coro)


class TestEmptyAndDefaults:
    def test_get_plan_on_empty_store_returns_default_document(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        plan = _run(store.get_plan())
        assert plan["version"] == 1
        assert plan["entries"] == []
        # only the general "meal" slot is active by default
        slot_ids = [slot["id"] for slot in plan["slots"] if slot.get("enabled")]
        assert slot_ids == ["meal"]

    def test_builtin_slots_are_present_with_stable_ids(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        plan = _run(store.get_plan())
        builtin = {slot["id"] for slot in plan["slots"] if slot["kind"] == "builtin"}
        assert {"meal", "breakfast", "lunch", "dinner", "snack", "dessert", "side"} <= builtin


class TestEntryCrud:
    def test_add_entry_persists_with_generated_uuid(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        entry = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        assert entry["id"]
        assert entry["date"] == "2026-09-07"
        assert entry["slot_id"] == "meal"
        assert entry["recipe_id"] == "12"
        plan = _run(store.get_plan())
        assert plan["entries"] == [entry]

    def test_same_recipe_can_be_planned_multiple_times(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        a = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        b = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        assert a["id"] != b["id"]
        plan = _run(store.get_plan())
        assert len(plan["entries"]) == 2

    def test_update_entry_changes_date_slot_recipe_keeping_id(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        entry = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        updated = _run(
            store.update_entry(entry["id"], date="2026-09-08", slot_id="dinner", recipe_id="4")
        )
        assert updated["id"] == entry["id"]
        assert updated["date"] == "2026-09-08"
        assert updated["slot_id"] == "dinner"
        assert updated["recipe_id"] == "4"

    def test_update_missing_entry_raises(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        try:
            _run(store.update_entry("nope", date="2026-09-08", slot_id="meal", recipe_id="4"))
        except EntryValidationError:
            return
        raise AssertionError("expected EntryValidationError for missing entry")

    def test_delete_entry_removes_only_that_entry(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        a = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        b = _run(store.add_entry(date="2026-09-08", slot_id="meal", recipe_id="4"))
        ok = _run(store.delete_entry(a["id"]))
        assert ok is True
        plan = _run(store.get_plan())
        assert [e["id"] for e in plan["entries"]] == [b["id"]]

    def test_add_free_text_entry_without_recipe_id(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        entry = _run(store.add_entry(date="2026-09-07", slot_id="meal", text="Pizza bestellen"))
        assert entry["text"] == "Pizza bestellen"
        assert entry["recipe_id"] == ""
        assert entry["id"]

    def test_add_recipe_entry_with_optional_note_text(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        entry = _run(
            store.add_entry(
                date="2026-09-07", slot_id="meal", recipe_id="12", text="Florian muss noch einkaufen"
            )
        )
        assert entry["recipe_id"] == "12"
        assert entry["text"] == "Florian muss noch einkaufen"

    def test_add_entry_requires_recipe_or_text(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        try:
            _run(store.add_entry(date="2026-09-07", slot_id="meal"))
        except EntryValidationError:
            return
        raise AssertionError("expected EntryValidationError when neither recipe_id nor text given")

    def test_update_entry_can_set_text_and_clear_recipe(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        entry = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        updated = _run(
            store.update_entry(entry["id"], date="2026-09-07", slot_id="meal", text="Lieferdienst")
        )
        assert updated["recipe_id"] == ""
        assert updated["text"] == "Lieferdienst"

    def test_add_entry_rejects_invalid_date(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        for bad in ("2026-13-01", "07-09-2026", "", "2026-09-7", "garbage"):
            try:
                _run(store.add_entry(date=bad, slot_id="meal", recipe_id="12"))
            except EntryValidationError:
                continue
            raise AssertionError(f"expected EntryValidationError for date {bad!r}")

    def test_add_entry_rejects_unknown_slot(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        try:
            _run(store.add_entry(date="2026-09-07", slot_id="does-not-exist", recipe_id="12"))
        except EntryValidationError:
            return
        raise AssertionError("expected EntryValidationError for unknown slot")


class TestPersistence:
    def test_plan_survives_a_fresh_store_instance(self, tmp_path: Path) -> None:
        path = tmp_path / "meal_plan.json"
        store = MealPlanStore(path)
        entry = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        reopened = MealPlanStore(path)
        plan = _run(reopened.get_plan())
        assert [e["id"] for e in plan["entries"]] == [entry["id"]]

    def test_no_temp_file_is_left_behind(self, tmp_path: Path) -> None:
        path = tmp_path / "meal_plan.json"
        store = MealPlanStore(path)
        _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        leftovers = [p.name for p in path.parent.iterdir() if p.name.endswith(".tmp")]
        assert leftovers == []


class TestSlotConfiguration:
    def test_add_custom_slot_generates_stable_id_from_name(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        slot = _run(store.add_custom_slot("Familienessen"))
        assert slot["kind"] == "custom"
        assert slot["name"] == "Familienessen"
        assert slot["id"] == "familienessen"
        plan = _run(store.get_plan())
        assert any(s["id"] == slot["id"] for s in plan["slots"])

    def test_add_custom_slot_ids_are_unique_for_similar_names(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        first = _run(store.add_custom_slot("Snack Zeit"))
        second = _run(store.add_custom_slot("Snack-Zeit!"))
        assert first["id"] != second["id"]

    def test_add_custom_slot_rejects_empty_name(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        try:
            _run(store.add_custom_slot("   "))
        except SlotValidationError:
            return
        raise AssertionError("expected SlotValidationError for empty name")

    def test_add_custom_slot_rejects_duplicate_name_case_insensitive(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        _run(store.add_custom_slot("Snack Time"))
        try:
            _run(store.add_custom_slot("snack time"))
        except SlotValidationError:
            return
        raise AssertionError("expected SlotValidationError for duplicate name")

    def test_rename_custom_slot_keeps_id(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        slot = _run(store.add_custom_slot("Familienessen"))
        renamed = _run(store.rename_slot(slot["id"], "Sonntagsessen"))
        assert renamed["id"] == slot["id"]
        assert renamed["name"] == "Sonntagsessen"

    def test_builtin_slot_cannot_be_deleted(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        try:
            _run(store.delete_slot("breakfast"))
        except SlotValidationError:
            return
        raise AssertionError("expected SlotValidationError deleting a builtin slot")

    def test_delete_custom_slot_remaps_entries_to_meal_when_active(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        slot = _run(store.add_custom_slot("Familienessen"))
        entry = _run(store.add_entry(date="2026-09-07", slot_id=slot["id"], recipe_id="12"))
        _run(store.delete_slot(slot["id"]))
        plan = _run(store.get_plan())
        moved = next(e for e in plan["entries"] if e["id"] == entry["id"])
        assert moved["slot_id"] == "meal"
        assert all(s["id"] != slot["id"] for s in plan["slots"])

    def test_delete_custom_slot_remaps_to_unassigned_when_meal_disabled(
        self, tmp_path: Path
    ) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        _run(store.set_slot_enabled("meal", False))
        slot = _run(store.add_custom_slot("Familienessen"))
        entry = _run(store.add_entry(date="2026-09-07", slot_id=slot["id"], recipe_id="12"))
        _run(store.delete_slot(slot["id"]))
        plan = _run(store.get_plan())
        moved = next(e for e in plan["entries"] if e["id"] == entry["id"])
        assert moved["slot_id"] == "unassigned"

    def test_reorder_slots_persists_order(self, tmp_path: Path) -> None:
        store = MealPlanStore(tmp_path / "meal_plan.json")
        _run(store.set_slot_enabled("breakfast", True))
        _run(store.set_slot_enabled("dinner", True))
        _run(store.reorder_slots(["dinner", "breakfast", "meal"]))
        plan = _run(store.get_plan())
        order = [s["id"] for s in plan["slots"]][:3]
        assert order == ["dinner", "breakfast", "meal"]
