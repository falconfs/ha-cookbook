"""Tests that list_stubs() exposes each recipe's source ``url`` (feature-01).

The Telegram chat-import feature must detect duplicates by source URL in a
single ``cookbook.list_recipes`` call. That requires the list stub to carry the
recipe's ``url`` field. Upstream, ``list_stubs`` only returned id/name/category/
keywords/dates/image_mtime, so a duplicate check would have needed one
``get_recipe`` call per recipe.

Run with:
    python3 -m pytest \
        integration/custom_components/cookbook/test_storage_list_stubs_url.py
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "storage.py"
_spec = importlib.util.spec_from_file_location("cookbook_storage", _MODULE_PATH)
assert _spec and _spec.loader
storage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(storage)

RecipeStore = storage.RecipeStore


def _run(coro):
    return asyncio.run(coro)


class TestListStubsUrl:
    def test_stub_includes_url_field(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(
            store.upsert(
                {"name": "Nudelsalat", "url": "https://example.com/nudelsalat"},
                "1",
            )
        )
        stubs = _run(store.list_stubs())
        assert len(stubs) == 1
        assert stubs[0]["url"] == "https://example.com/nudelsalat"

    def test_stub_url_defaults_to_empty_string_when_absent(
        self, tmp_path: Path
    ) -> None:
        store = RecipeStore(tmp_path)
        _run(store.upsert({"name": "Ohne Quelle"}, "2"))
        stubs = _run(store.list_stubs())
        assert len(stubs) == 1
        assert stubs[0]["url"] == ""

    def test_stub_includes_optional_rating(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(store.upsert({"name": "Bewertet", "_ha_rating": 4}, "3"))
        stubs = _run(store.list_stubs())
        assert stubs[0]["_ha_rating"] == 4

    def test_multiple_recipes_each_carry_their_url(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(store.upsert({"name": "A", "url": "https://a.example/x"}, "1"))
        _run(store.upsert({"name": "B", "url": "https://b.example/y"}, "2"))
        stubs = _run(store.list_stubs())
        urls = {stub["id"]: stub["url"] for stub in stubs}
        assert urls == {
            "1": "https://a.example/x",
            "2": "https://b.example/y",
        }
