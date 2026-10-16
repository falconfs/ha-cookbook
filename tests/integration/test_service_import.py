"""Tests for the native URL import and automatic AI fallback HA service.

register_services is invoked with fake Home Assistant services and injected
download/parser functions. Tests verify native success, single-download AI
fallback, AI error translation, and that URL/download failures never call AI.
Home Assistant / voluptuous are stubbed via conftest.

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


def _register_and_get_handler(monkeypatch, fake_draft, *, download_error=None):
    """Register services with a fake hass and patched parser."""
    # Avoid touching real aiohttp/HA session machinery.
    monkeypatch.setattr(services_module, "_get_image_session", lambda hass: object())

    async def fake_download(url, *, session):
        if download_error is not None:
            raise download_error
        return "<html></html>"

    monkeypatch.setattr(services_module, "download_html", fake_download)
    monkeypatch.setattr(services_module, "parse_recipe_html", fake_draft)
    hass = _FakeHass()
    register_services(hass, store=object())
    return hass.services.handlers["import_recipe_from_url"]


class TestSuccess:
    def test_returns_recipe_on_success(self, monkeypatch) -> None:
        def fake_draft(html, *, source_url):
            return {"name": "Cake", "_cookbook_schema_version": 6}

        handler = _register_and_get_handler(monkeypatch, fake_draft)
        result = _run(handler(_Call({"url": "https://example.com/cake"})))
        assert result == {
            "recipe": {"name": "Cake", "_cookbook_schema_version": 6},
            "import_method": "native",
        }


class TestErrorTranslation:
    def test_invalid_url_message(self, monkeypatch) -> None:
        handler = _register_and_get_handler(
            monkeypatch,
            lambda html, **kwargs: {},
            download_error=services_module.UrlValidationError("blocked"),
        )
        result = _run(handler(_Call({"url": "ftp://x"})))
        assert "error" in result
        assert result["error_code"] == "import_url_invalid"
        assert "recipe" not in result

    def test_download_error_message(self, monkeypatch) -> None:
        handler = _register_and_get_handler(
            monkeypatch,
            lambda html, **kwargs: {},
            download_error=services_module.DownloadError("404"),
        )
        result = _run(handler(_Call({"url": "https://example.com/missing"})))
        assert "error" in result
        assert result["error_code"] == "page_download_failed"
        assert "recipe" not in result

    def test_ai_failure_message_when_no_recipe_markup(self, monkeypatch) -> None:
        def fake_draft(html, **kwargs):
            raise services_module.RecipeImportError("none")

        handler = _register_and_get_handler(monkeypatch, fake_draft)
        result = _run(handler(_Call({"url": "https://example.com/blog"})))
        assert "error" in result
        assert result["error_code"] == "ai_request_failed"
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


def test_url_import_falls_back_to_ai_after_unusable_markup(monkeypatch) -> None:
    downloads: list[str] = []
    ai_calls: list[dict] = []
    ai_data = {
        "name": "KI-Lasagne",
        "recipeInstructions": [
            {
                "instruction": "Backen.",
                "ingredients": [
                    {"name": "Lasagneplatten", "amount": "9", "unit": "", "note": ""}
                ],
            }
        ],
    }

    async def fake_download(url, *, session):
        downloads.append(url)
        return "<html><body>Lasagne und Gemüse</body></html>"

    def fake_parse(_html, *, source_url):
        raise services_module.RecipeImportError("no usable markup")

    async def fake_generate_data(domain, service, data, **kwargs):
        ai_calls.append({"domain": domain, "service": service, "data": data})
        return {"data": ai_data}

    monkeypatch.setattr(services_module, "_get_image_session", lambda hass: object())
    monkeypatch.setattr(services_module, "download_html", fake_download)
    monkeypatch.setattr(services_module, "parse_recipe_html", fake_parse, raising=False)

    hass = _FakeHass()
    hass.services.async_call = fake_generate_data
    register_services(hass, store=object())
    result = _run(
        hass.services.handlers["import_recipe_from_url"](
            _Call({"url": "https://example.com/lasagne", "ai_task_entity": "ai_task.test"})
        )
    )

    assert result["recipe"]["name"] == "KI-Lasagne"
    assert result["import_method"] == "ai"
    assert downloads == ["https://example.com/lasagne"]
    assert len(ai_calls) == 1
    assert ai_calls[0]["domain"] == "ai_task"
    assert ai_calls[0]["service"] == "generate_data"
    assert ai_calls[0]["data"]["entity_id"] == "ai_task.test"
    assert "Lasagne und Gemüse" in ai_calls[0]["data"]["instructions"]


def _setup_auto_import(
    monkeypatch,
    *,
    parser,
    html="<html><body>Recipe text</body></html>",
    download_error=None,
    ai_response=None,
):
    downloads: list[str] = []
    ai_calls: list[dict] = []
    if ai_response is None:
        ai_response = {
            "data": {
                "name": "AI recipe",
                "recipeInstructions": [
                    {
                        "instruction": "Cook.",
                        "ingredients": [
                            {"name": "Tomato", "amount": "1", "unit": "", "note": ""}
                        ],
                    }
                ],
            }
        }

    async def fake_download(url, *, session):
        downloads.append(url)
        if download_error is not None:
            raise download_error
        return html

    def fake_parse(source_html, *, source_url):
        return parser(source_html, source_url=source_url)

    monkeypatch.setattr(services_module, "_get_image_session", lambda hass: object())
    monkeypatch.setattr(services_module, "download_html", fake_download)
    monkeypatch.setattr(services_module, "parse_recipe_html", fake_parse, raising=False)

    hass = _FakeHass()

    async def fake_ai_call(domain, service, data, **kwargs):
        ai_calls.append({"domain": domain, "service": service, "data": data})
        if isinstance(ai_response, Exception):
            raise ai_response
        return ai_response

    hass.services.async_call = fake_ai_call
    register_services(hass, store=object())
    return hass, downloads, ai_calls


def test_url_import_returns_native_method_without_calling_ai(monkeypatch) -> None:
    native_recipe = {
        "name": "Native cake",
        "recipeInstructions": [
            {"instruction": "Bake.", "ingredients": [{"name": "Flour"}]}
        ],
        "_cookbook_schema_version": 6,
    }
    hass, downloads, ai_calls = _setup_auto_import(
        monkeypatch,
        parser=lambda _html, **kwargs: native_recipe,
    )

    result = _run(
        hass.services.handlers["import_recipe_from_url"](
            _Call({"url": "https://example.com/cake"})
        )
    )

    assert result == {"recipe": native_recipe, "import_method": "native"}
    assert len(downloads) == 1
    assert ai_calls == []


@pytest.mark.parametrize(
    ("failure", "expected_code"),
    [
        (services_module.UrlValidationError("blocked"), "import_url_invalid"),
        (services_module.DownloadError("offline"), "page_download_failed"),
    ],
)
def test_url_import_does_not_call_ai_when_download_fails(
    monkeypatch, failure, expected_code
) -> None:
    hass, _downloads, ai_calls = _setup_auto_import(
        monkeypatch,
        parser=lambda _html, **kwargs: {},
        download_error=failure,
    )

    result = _run(
        hass.services.handlers["import_recipe_from_url"](
            _Call({"url": "https://example.com/cake"})
        )
    )

    assert result["error_code"] == expected_code
    assert ai_calls == []


@pytest.mark.parametrize(
    ("ai_response", "expected_code"),
    [
        ({"data": {"name": "", "recipeInstructions": []}}, "ai_recipe_invalid"),
        (RuntimeError("AI unavailable"), "ai_request_failed"),
    ],
)
def test_url_import_reports_ai_failure_without_recipe(
    monkeypatch, ai_response, expected_code
) -> None:
    def no_native_recipe(_html, *, source_url):
        raise services_module.RecipeImportError("no usable markup")

    hass, _downloads, ai_calls = _setup_auto_import(
        monkeypatch,
        parser=no_native_recipe,
        ai_response=ai_response,
    )

    result = _run(
        hass.services.handlers["import_recipe_from_url"](
            _Call({"url": "https://example.com/cake"})
        )
    )

    assert result["error_code"] == expected_code
    assert "recipe" not in result
    assert len(ai_calls) == 1
