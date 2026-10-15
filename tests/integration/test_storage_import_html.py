"""Tests for storing the downloaded raw HTML as an audit artifact (feature-07).

Like upstream Nextcloud Cookbook, the downloaded page is saved per recipe as
import.html under the recipe directory, for audit/review. The store writes it
atomically, mirroring the recipe.json write pattern.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_storage_import_html.py
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "storage.py"
_spec = importlib.util.spec_from_file_location("cookbook_storage", _MODULE_PATH)
assert _spec and _spec.loader
storage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(storage)

RecipeStore = storage.RecipeStore


def _run(coro):
    return asyncio.run(coro)


class TestSaveImportHtml:
    def test_writes_import_html_into_recipe_dir(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(store.save_import_html("42", "<html>source</html>"))
        target = tmp_path / "42" / "import.html"
        assert target.is_file()
        assert target.read_text(encoding="utf-8") == "<html>source</html>"

    def test_creates_recipe_dir_when_missing(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(store.save_import_html("7", "<html></html>"))
        assert (tmp_path / "7").is_dir()

    def test_overwrites_existing_import_html(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(store.save_import_html("1", "<html>old</html>"))
        _run(store.save_import_html("1", "<html>new</html>"))
        target = tmp_path / "1" / "import.html"
        assert target.read_text(encoding="utf-8") == "<html>new</html>"

    def test_no_leftover_tmp_file(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(store.save_import_html("9", "<html></html>"))
        leftovers = list((tmp_path / "9").glob("*.tmp"))
        assert leftovers == []

    def test_import_html_survives_recipe_write(self, tmp_path: Path) -> None:
        store = RecipeStore(tmp_path)
        _run(store.save_import_html("5", "<html>src</html>"))
        _run(store.upsert({"name": "X"}, "5"))
        assert (tmp_path / "5" / "import.html").is_file()
        assert (tmp_path / "5" / "recipe.json").is_file()
