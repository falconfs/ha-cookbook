"""Tests for the AI HA service wrappers (feature-07, R4c + R10-R13).

register_services is invoked with a fake hass that records handlers and stubs
hass.services.async_call for ai_task.generate_data. Verifies the success
payload, error translation, and that ai_task is called with instructions +
structure (and the optional entity_id).

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_service_ai.py
"""

from __future__ import annotations

import asyncio

from custom_components.cookbook import services as services_module
from custom_components.cookbook.services import register_services


def _run(coro):
    return asyncio.run(coro)


class _Call:
    def __init__(self, data: dict) -> None:
        self.data = data


class _FakeServices:
    def __init__(self, ai_response) -> None:
        self.handlers: dict[str, object] = {}
        self._ai_response = ai_response
        self.calls: list[dict] = []

    def async_register(self, domain, name, handler, **kwargs) -> None:
        self.handlers[name] = handler

    async def async_call(self, domain, service, data, blocking=False, return_response=False):
        self.calls.append({"domain": domain, "service": service, "data": data})
        if callable(self._ai_response):
            return self._ai_response(data)
        return self._ai_response


class _FakeHass:
    def __init__(self, ai_response) -> None:
        self.services = _FakeServices(ai_response)


def _setup(monkeypatch, ai_response, *, download_html=None, visible_text="raw text"):
    monkeypatch.setattr(services_module, "_get_image_session", lambda hass: object())
    if download_html is not None:
        monkeypatch.setattr(services_module, "download_html", download_html)
    monkeypatch.setattr(services_module, "extract_visible_text", lambda html: visible_text)
    hass = _FakeHass(ai_response)
    register_services(hass, store=object())
    return hass


_VALID_AI = {
    "conversation_id": "c1",
    "data": {
        "name": "KI Rezept",
        "recipeInstructions": [
            {"instruction": "Kochen.", "ingredients": [
                {"name": "Salz", "amount": "1", "unit": "Prise", "note": ""}]},
        ],
    },
}


class TestAiImportFromUrl:
    def test_success_returns_recipe(self, monkeypatch) -> None:
        async def fake_dl(url, *, session, resolve=None):
            return "<html>x</html>"
        hass = _setup(monkeypatch, _VALID_AI, download_html=fake_dl)
        handler = hass.services.handlers["ai_import_recipe_from_url"]
        result = _run(handler(_Call({"url": "https://x.test/r"})))
        assert result["recipe"]["name"] == "KI Rezept"
        assert result["recipe"]["_cookbook_schema_version"] == 6
        # ai_task.generate_data was called with instructions + structure.
        ai_call = [c for c in hass.services.calls if c["service"] == "generate_data"][0]
        assert ai_call["domain"] == "ai_task"
        assert "instructions" in ai_call["data"]
        assert "structure" in ai_call["data"]

    def test_passes_entity_id(self, monkeypatch) -> None:
        async def fake_dl(url, *, session, resolve=None):
            return "<html>x</html>"
        hass = _setup(monkeypatch, _VALID_AI, download_html=fake_dl)
        handler = hass.services.handlers["ai_import_recipe_from_url"]
        _run(handler(_Call({"url": "https://x.test/r", "ai_task_entity": "ai_task.openai_ai_task"})))
        ai_call = [c for c in hass.services.calls if c["service"] == "generate_data"][0]
        assert ai_call["data"]["entity_id"] == "ai_task.openai_ai_task"

    def test_invalid_ai_response_is_translated(self, monkeypatch) -> None:
        async def fake_dl(url, *, session, resolve=None):
            return "<html>x</html>"
        bad = {"conversation_id": "c", "data": {"name": "", "recipeInstructions": []}}
        hass = _setup(monkeypatch, bad, download_html=fake_dl)
        handler = hass.services.handlers["ai_import_recipe_from_url"]
        result = _run(handler(_Call({"url": "https://x.test/r"})))
        assert "error" in result and "recipe" not in result
        assert result["error_code"] == "ai_recipe_invalid"

    def test_download_failure_translated(self, monkeypatch) -> None:
        async def fake_dl(url, *, session, resolve=None):
            raise services_module.DownloadError("404")
        hass = _setup(monkeypatch, _VALID_AI, download_html=fake_dl)
        handler = hass.services.handlers["ai_import_recipe_from_url"]
        result = _run(handler(_Call({"url": "https://x.test/missing"})))
        assert "error" in result
        assert result["error_code"] == "page_download_failed"


class TestAiRegroup:
    def _recipe(self):
        return {
            "name": "Pfannkuchen",
            "url": "https://x.test/r",
            "recipeInstructions": [
                {"instruction": "Mehl mischen.", "ingredients": [
                    {"name": "Mehl", "amount": "250", "unit": "g", "note": ""},
                    {"name": "Eier", "amount": "2", "unit": "", "note": ""}]},
                {"instruction": "Eier dazu.", "ingredients": []},
            ],
        }

    def test_success(self, monkeypatch) -> None:
        regrouped = {
            "conversation_id": "c",
            "data": {
                "name": "Pfannkuchen",
                "recipeInstructions": [
                    {"instruction": "Mehl mischen.", "ingredients": [
                        {"name": "Mehl", "amount": "250", "unit": "g", "note": ""}]},
                    {"instruction": "Eier dazu.", "ingredients": [
                        {"name": "Eier", "amount": "2", "unit": "", "note": ""}]},
                ],
            },
        }
        hass = _setup(monkeypatch, regrouped)
        handler = hass.services.handlers["ai_regroup_recipe"]
        result = _run(handler(_Call({"recipe": self._recipe()})))
        assert [i["name"] for i in result["recipe"]["recipeInstructions"][1]["ingredients"]] == ["Eier"]

    def test_invalid_translated(self, monkeypatch) -> None:
        bad = {"conversation_id": "c", "data": {"name": "X", "recipeInstructions": "no"}}
        hass = _setup(monkeypatch, bad)
        handler = hass.services.handlers["ai_regroup_recipe"]
        result = _run(handler(_Call({"recipe": self._recipe()})))
        assert "error" in result
        assert result["error_code"] == "ai_result_invalid"
