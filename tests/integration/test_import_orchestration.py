"""Tests for the HA-independent import orchestration helper (feature-07).

`import_recipe_draft` chains the pure building blocks so the HA service becomes
a thin wrapper:
    download_html -> JSON-LD -> (fallback) Microdata -> normalize_to_v6
It also persists the raw HTML as import.html when a recipe id is provided.

Everything is injected (session, resolver, store) so this is fully unit
testable without Home Assistant or the network.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_import_orchestration.py
"""

from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path

import pytest

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "url_import.py"
_spec = importlib.util.spec_from_file_location("cookbook_url_import", _MODULE_PATH)
assert _spec and _spec.loader
url_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_import)

import_recipe_draft = url_import.import_recipe_draft
ImportError_ = url_import.RecipeImportError
UrlValidationError = url_import.UrlValidationError
DownloadError = url_import.DownloadError


def _run(coro):
    return asyncio.run(coro)


def _resolver():
    async def resolve(host: str) -> list[str]:
        return ["93.184.216.34"]

    return resolve


class _FakeResponse:
    def __init__(self, status: int, body: str) -> None:
        self.status = status
        self._body = body

    async def __aenter__(self) -> "_FakeResponse":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def text(self) -> str:
        return self._body


class _FakeSession:
    def __init__(self, status: int = 200, body: str = "") -> None:
        self._status = status
        self._body = body

    def get(self, url: str, headers=None, **kwargs):
        return _FakeResponse(self._status, self._body)


class _FakeStore:
    def __init__(self) -> None:
        self.saved: dict[str, str] = {}

    async def save_import_html(self, recipe_id: str, html: str) -> None:
        self.saved[recipe_id] = html


_JSONLD_HTML = (
    "<html><head>"
    '<script type="application/ld+json">'
    '{"@type":"Recipe","name":"JsonLd Cake",'
    '"recipeIngredient":["250 g Mehl"],'
    '"recipeInstructions":["Mehl verrühren."]}'
    "</script></head><body></body></html>"
)

_MICRODATA_HTML = (
    '<div itemscope itemtype="https://schema.org/Recipe">'
    '<h1 itemprop="name">Microdata Cake</h1>'
    '<li itemprop="recipeIngredient">2 Eier</li>'
    '<li itemprop="recipeInstructions">Eier unterrühren.</li></div>'
)

_NO_RECIPE_HTML = "<html><body><p>Just a blog post.</p></body></html>"


class TestJsonLdPreferred:
    def test_uses_jsonld_when_present(self) -> None:
        draft = _run(
            import_recipe_draft(
                "https://example.com/cake",
                session=_FakeSession(body=_JSONLD_HTML),
                store=None,
                resolve=_resolver(),
            )
        )
        assert draft["name"] == "JsonLd Cake"
        assert draft["_cookbook_schema_version"] == 6
        assert draft["url"] == "https://example.com/cake"

    def test_normalizes_and_maps_ingredients_to_steps(self) -> None:
        draft = _run(
            import_recipe_draft(
                "https://example.com/cake",
                session=_FakeSession(body=_JSONLD_HTML),
                store=None,
                resolve=_resolver(),
            )
        )
        step = draft["recipeInstructions"][0]
        assert [i["name"] for i in step["ingredients"]] == ["Mehl"]
        assert step["ingredients"][0]["amount"] == "250"
        assert step["ingredients"][0]["unit"] == "g"


class TestMicrodataFallback:
    def test_falls_back_to_microdata(self) -> None:
        draft = _run(
            import_recipe_draft(
                "https://example.com/cake",
                session=_FakeSession(body=_MICRODATA_HTML),
                store=None,
                resolve=_resolver(),
            )
        )
        assert draft["name"] == "Microdata Cake"
        assert [i["name"] for i in draft["recipeInstructions"][0]["ingredients"]] == ["Eier"]


class TestNoRecipeFound:
    def test_raises_when_no_markup(self) -> None:
        with pytest.raises(ImportError_):
            _run(
                import_recipe_draft(
                    "https://example.com/blog",
                    session=_FakeSession(body=_NO_RECIPE_HTML),
                    store=None,
                    resolve=_resolver(),
                )
            )


class TestErrorPropagation:
    def test_invalid_url_propagates(self) -> None:
        with pytest.raises(UrlValidationError):
            _run(
                import_recipe_draft(
                    "ftp://example.com/x",
                    session=_FakeSession(body=_JSONLD_HTML),
                    store=None,
                    resolve=_resolver(),
                )
            )

    def test_download_error_propagates(self) -> None:
        with pytest.raises(DownloadError):
            _run(
                import_recipe_draft(
                    "https://example.com/missing",
                    session=_FakeSession(status=404, body="nope"),
                    store=None,
                    resolve=_resolver(),
                )
            )


class TestImportHtmlPersistence:
    def test_saves_import_html_when_store_and_id_given(self) -> None:
        store = _FakeStore()
        _run(
            import_recipe_draft(
                "https://example.com/cake",
                session=_FakeSession(body=_JSONLD_HTML),
                store=store,
                recipe_id="42",
                resolve=_resolver(),
            )
        )
        assert store.saved["42"] == _JSONLD_HTML

    def test_does_not_save_without_recipe_id(self) -> None:
        store = _FakeStore()
        _run(
            import_recipe_draft(
                "https://example.com/cake",
                session=_FakeSession(body=_JSONLD_HTML),
                store=store,
                resolve=_resolver(),
            )
        )
        assert store.saved == {}

    def test_does_not_save_html_when_no_recipe_found(self) -> None:
        store = _FakeStore()
        with pytest.raises(ImportError_):
            _run(
                import_recipe_draft(
                    "https://example.com/blog",
                    session=_FakeSession(body=_NO_RECIPE_HTML),
                    store=store,
                    recipe_id="42",
                    resolve=_resolver(),
                )
            )
        assert store.saved == {}
