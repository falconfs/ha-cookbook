"""Tests for the meal-plan HA service wrappers (feature-10).

register_services is invoked with a fake hass that records registered handlers
and a real MealPlanStore backed by a temp file. These tests verify the service
payload shapes for reading the plan and for entry/slot mutations, plus error
translation into a non-technical ``{"error": ...}`` payload.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_service_meal_plan.py
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from custom_components.cookbook.meal_plan_store import MealPlanStore
from custom_components.cookbook.services import register_services


def _run(coro):
    return asyncio.run(coro)


class _Call:
    def __init__(self, data: dict) -> None:
        self.data = data


class _FakeServices:
    def __init__(self) -> None:
        self.handlers: dict[str, object] = {}

    def async_register(self, domain, name, handler, **kwargs) -> None:
        self.handlers[name] = handler


class _FakeHass:
    def __init__(self) -> None:
        self.services = _FakeServices()


def _handlers(tmp_path: Path):
    hass = _FakeHass()
    meal_plan_store = MealPlanStore(tmp_path / "meal_plan.json")
    register_services(hass, store=object(), meal_plan_store=meal_plan_store)
    return hass.services.handlers, meal_plan_store


class TestGetPlan:
    def test_get_meal_plan_returns_default_document(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        result = _run(handlers["get_meal_plan"](_Call({})))
        assert result["plan"]["version"] == 1
        assert result["plan"]["entries"] == []


class TestEntryServices:
    def test_add_meal_plan_entry_returns_entry(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        result = _run(
            handlers["add_meal_plan_entry"](
                _Call({"date": "2026-09-07", "slot_id": "meal", "recipe_id": "12"})
            )
        )
        assert result["entry"]["id"]
        assert result["entry"]["recipe_id"] == "12"

    def test_add_free_text_entry_without_recipe(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        result = _run(
            handlers["add_meal_plan_entry"](
                _Call({"date": "2026-09-07", "slot_id": "meal", "text": "Pizza bestellen"})
            )
        )
        assert result["entry"]["text"] == "Pizza bestellen"
        assert result["entry"]["recipe_id"] == ""

    def test_add_recipe_entry_with_note(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        result = _run(
            handlers["add_meal_plan_entry"](
                _Call({"date": "2026-09-07", "slot_id": "meal", "recipe_id": "12", "text": "Note"})
            )
        )
        assert result["entry"]["recipe_id"] == "12"
        assert result["entry"]["text"] == "Note"

    def test_add_entry_without_recipe_or_text_returns_error(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        result = _run(
            handlers["add_meal_plan_entry"](_Call({"date": "2026-09-07", "slot_id": "meal"}))
        )
        assert "error" in result
        assert result["error_code"] == "invalid_meal_plan_entry"
        assert "entry" not in result

    def test_add_meal_plan_entry_invalid_date_returns_error(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        result = _run(
            handlers["add_meal_plan_entry"](
                _Call({"date": "not-a-date", "slot_id": "meal", "recipe_id": "12"})
            )
        )
        assert "error" in result
        assert "entry" not in result

    def test_update_meal_plan_entry_changes_fields(self, tmp_path: Path) -> None:
        handlers, store = _handlers(tmp_path)
        entry = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        result = _run(
            handlers["update_meal_plan_entry"](
                _Call(
                    {
                        "entry_id": entry["id"],
                        "date": "2026-09-08",
                        "slot_id": "meal",
                        "recipe_id": "4",
                    }
                )
            )
        )
        assert result["entry"]["date"] == "2026-09-08"
        assert result["entry"]["recipe_id"] == "4"

    def test_delete_meal_plan_entry_returns_ok(self, tmp_path: Path) -> None:
        handlers, store = _handlers(tmp_path)
        entry = _run(store.add_entry(date="2026-09-07", slot_id="meal", recipe_id="12"))
        result = _run(handlers["delete_meal_plan_entry"](_Call({"entry_id": entry["id"]})))
        assert result["ok"] is True


class TestSlotServices:
    def test_save_meal_plan_slots_replaces_configuration(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        slots = [
            {"id": "meal", "kind": "builtin", "enabled": True},
            {"id": "dinner", "kind": "builtin", "enabled": True},
            {"kind": "custom", "name": "Familienessen", "enabled": True},
        ]
        result = _run(handlers["save_meal_plan_slots"](_Call({"slots": slots})))
        ids = [s["id"] for s in result["plan"]["slots"]]
        assert "dinner" in ids
        assert any(s.get("name") == "Familienessen" for s in result["plan"]["slots"])

    def test_save_meal_plan_slots_duplicate_name_returns_error(self, tmp_path: Path) -> None:
        handlers, _ = _handlers(tmp_path)
        slots = [
            {"kind": "custom", "name": "Snack", "enabled": True},
            {"kind": "custom", "name": "snack", "enabled": True},
        ]
        result = _run(handlers["save_meal_plan_slots"](_Call({"slots": slots})))
        assert "error" in result
        assert result["error_code"] == "slot_validation_failed"
