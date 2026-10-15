"""Tests for the import_recipe_from_url HA service wrapper (feature-07).

register_services is invoked with a fake hass that records registered handlers.
The wrapper is a thin layer over the tested import_recipe_draft orchestrator;
these tests verify the success payload shape and the translation of each error
class into a non-technical message (R7). Home Assistant / voluptuous are stubbed
via conftest.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_service_import.py
"""

from __future__ import annotations

import asyncio

import pytest

from custom_components.cookbook import services as services_module
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


def _register_and_get_handler(monkeypatch, fake_draft):
    """Register services with a fake hass and patched orchestrator; return the
    import_recipe_from_url handler."""
    monkeypatch.setattr(services_module, "import_recipe_draft", fake_draft)
    # Avoid touching real aiohttp/HA session machinery.
    monkeypatch.setattr(services_module, "_get_image_session", lambda hass: object())
    hass = _FakeHass()
    register_services(hass, store=object())
    return hass.services.handlers["import_recipe_from_url"]


class TestSuccess:
    def test_returns_recipe_on_success(self, monkeypatch) -> None:
        async def fake_draft(url, *, session, store=None, recipe_id=None, resolve=None):
            return {"name": "Cake", "_cookbook_schema_version": 6}

        handler = _register_and_get_handler(monkeypatch, fake_draft)
        result = _run(handler(_Call({"url": "https://example.com/cake"})))
        assert result == {"recipe": {"name": "Cake", "_cookbook_schema_version": 6}}


class TestErrorTranslation:
    def test_invalid_url_message(self, monkeypatch) -> None:
        async def fake_draft(url, **kwargs):
            raise services_module.UrlValidationError("blocked")

        handler = _register_and_get_handler(monkeypatch, fake_draft)
        result = _run(handler(_Call({"url": "ftp://x"})))
        assert "error" in result
        assert result["error_code"] == "import_url_invalid"
        assert "recipe" not in result

    def test_download_error_message(self, monkeypatch) -> None:
        async def fake_draft(url, **kwargs):
            raise services_module.DownloadError("404")

        handler = _register_and_get_handler(monkeypatch, fake_draft)
        result = _run(handler(_Call({"url": "https://example.com/missing"})))
        assert "error" in result
        assert result["error_code"] == "page_download_failed"
        assert "recipe" not in result

    def test_no_recipe_message(self, monkeypatch) -> None:
        async def fake_draft(url, **kwargs):
            raise services_module.RecipeImportError("none")

        handler = _register_and_get_handler(monkeypatch, fake_draft)
        result = _run(handler(_Call({"url": "https://example.com/blog"})))
        assert "error" in result
        assert result["error_code"] == "recipe_markup_missing"
        assert "recipe" not in result


@pytest.mark.parametrize(
    ("failure", "expected_code"),
    [
        ("Invalid image URL", "image_invalid_url"),
        ("Unsupported image", "image_unsupported"),
        ("Image download failed (404)", "image_download_failed"),
    ],
)
def test_image_download_errors_include_stable_codes(monkeypatch, failure, expected_code):
    async def fake_download(session, image_url):
        return None, failure

    monkeypatch.setattr(services_module, "_get_image_session", lambda hass: object())
    monkeypatch.setattr(services_module, "_download_image", fake_download)
    hass = _FakeHass()
    register_services(hass, store=object())

    result = _run(hass.services.handlers["fetch_image_to_tmp"](_Call({"image_url": "bad"})))

    assert result["error_code"] == expected_code
