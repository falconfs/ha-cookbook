"""Tests for the server-side HTML download with DNS-level SSRF re-check.

The pure validator (validate_import_url) only hard-checks IP literals; a
hostname could still resolve to an internal address. The download layer closes
that gap: it resolves the host and rejects the request if ANY resolved address
is an internal/blocked target, before any content is fetched.

The HTTP client and the DNS resolver are injected so this stays unit-testable
without real network access.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_html_download.py
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

download_html = url_import.download_html
DownloadError = url_import.DownloadError
UrlValidationError = url_import.UrlValidationError


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
    """Minimal aiohttp-like session capturing the request for assertions."""

    def __init__(self, status: int = 200, body: str = "<html></html>") -> None:
        self._status = status
        self._body = body
        self.requested_url: str | None = None
        self.requested_headers: dict[str, str] | None = None

    def get(self, url: str, headers: dict[str, str] | None = None, **kwargs: object) -> _FakeResponse:
        self.requested_url = url
        self.requested_headers = headers
        return _FakeResponse(self._status, self._body)


def _resolver(mapping: dict[str, list[str]]):
    async def resolve(host: str) -> list[str]:
        return mapping.get(host, ["93.184.216.34"])  # default: a public IP

    return resolve


def _run(coro):
    return asyncio.run(coro)


class TestSuccess:
    def test_returns_body_for_public_host(self) -> None:
        session = _FakeSession(status=200, body="<html>ok</html>")
        html = _run(
            download_html(
                "https://example.com/recipe",
                session=session,
                resolve=_resolver({"example.com": ["93.184.216.34"]}),
            )
        )
        assert html == "<html>ok</html>"
        assert session.requested_url == "https://example.com/recipe"

    def test_sends_browser_like_user_agent(self) -> None:
        session = _FakeSession()
        _run(
            download_html(
                "https://example.com/recipe",
                session=session,
                resolve=_resolver({"example.com": ["93.184.216.34"]}),
            )
        )
        assert session.requested_headers is not None
        ua = session.requested_headers.get("User-Agent", "")
        assert "Mozilla" in ua


class TestValidation:
    def test_rejects_non_http_scheme_before_request(self) -> None:
        session = _FakeSession()
        with pytest.raises(UrlValidationError):
            _run(download_html("ftp://example.com/x", session=session, resolve=_resolver({})))
        assert session.requested_url is None

    def test_rejects_ip_literal_loopback(self) -> None:
        session = _FakeSession()
        with pytest.raises(UrlValidationError):
            _run(download_html("http://127.0.0.1/x", session=session, resolve=_resolver({})))
        assert session.requested_url is None


class TestDnsSsrf:
    def test_rejects_hostname_resolving_to_private_ip(self) -> None:
        session = _FakeSession()
        with pytest.raises(UrlValidationError):
            _run(
                download_html(
                    "https://evil.example.com/x",
                    session=session,
                    resolve=_resolver({"evil.example.com": ["10.0.0.5"]}),
                )
            )
        assert session.requested_url is None

    def test_rejects_when_any_resolved_ip_is_internal(self) -> None:
        session = _FakeSession()
        with pytest.raises(UrlValidationError):
            _run(
                download_html(
                    "https://mixed.example.com/x",
                    session=session,
                    resolve=_resolver({"mixed.example.com": ["93.184.216.34", "169.254.169.254"]}),
                )
            )
        assert session.requested_url is None

    def test_rejects_loopback_hostname_resolution(self) -> None:
        session = _FakeSession()
        with pytest.raises(UrlValidationError):
            _run(
                download_html(
                    "https://localtest.me/x",
                    session=session,
                    resolve=_resolver({"localtest.me": ["127.0.0.1"]}),
                )
            )
        assert session.requested_url is None

    def test_allows_public_resolution(self) -> None:
        session = _FakeSession(body="<html>fine</html>")
        html = _run(
            download_html(
                "https://good.example.com/x",
                session=session,
                resolve=_resolver({"good.example.com": ["93.184.216.34"]}),
            )
        )
        assert html == "<html>fine</html>"


class TestHttpErrors:
    def test_non_2xx_raises_download_error(self) -> None:
        session = _FakeSession(status=404, body="not found")
        with pytest.raises(DownloadError):
            _run(
                download_html(
                    "https://example.com/missing",
                    session=session,
                    resolve=_resolver({"example.com": ["93.184.216.34"]}),
                )
            )

    def test_500_raises_download_error(self) -> None:
        session = _FakeSession(status=500, body="server error")
        with pytest.raises(DownloadError):
            _run(
                download_html(
                    "https://example.com/boom",
                    session=session,
                    resolve=_resolver({"example.com": ["93.184.216.34"]}),
                )
            )


extract_visible_text = url_import.extract_visible_text


class TestExtractVisibleText:
    def test_extracts_visible_text(self) -> None:
        html = "<html><body><h1>Titel</h1><p>Ein Absatz.</p></body></html>"
        text = extract_visible_text(html)
        assert "Titel" in text
        assert "Ein Absatz." in text

    def test_excludes_script_and_style(self) -> None:
        html = (
            "<html><head><style>.x{color:red}</style>"
            "<script>var a=1;</script></head>"
            "<body><p>Sichtbar</p><script>console.log('x')</script></body></html>"
        )
        text = extract_visible_text(html)
        assert "Sichtbar" in text
        assert "color:red" not in text
        assert "console.log" not in text
        assert "var a=1" not in text

    def test_collapses_whitespace(self) -> None:
        html = "<p>Zeile1</p>\n\n   <p>Zeile2</p>"
        text = extract_visible_text(html)
        assert "  " not in text  # no double spaces

    def test_empty_html(self) -> None:
        assert extract_visible_text("") == ""
