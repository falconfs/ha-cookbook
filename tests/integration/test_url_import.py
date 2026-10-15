"""Tests for the native URL recipe import (feature-07).

TDD entry point: these tests describe the pure, HA-independent import logic
before any implementation exists. The first unit under test is URL validation
including SSRF protection (AC5).

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_url_import.py
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# Load the pure url_import module directly by path so the test never pulls in
# the HA package __init__ (which imports homeassistant). The import logic under
# test must stay free of Home Assistant runtime dependencies.
_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "url_import.py"
_spec = importlib.util.spec_from_file_location("cookbook_url_import", _MODULE_PATH)
assert _spec and _spec.loader
url_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_import)

UrlValidationError = url_import.UrlValidationError
validate_import_url = url_import.validate_import_url


class TestValidateImportUrlAccepts:
    def test_accepts_public_https_url(self) -> None:
        assert validate_import_url("https://example.com/recipe") == (
            "https://example.com/recipe"
        )

    def test_accepts_public_http_url(self) -> None:
        assert validate_import_url("http://example.com/recipe") == (
            "http://example.com/recipe"
        )


class TestValidateImportUrlRejectsScheme:
    @pytest.mark.parametrize(
        "url",
        [
            "ftp://example.com/recipe",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "example.com/recipe",  # no scheme
            "",
        ],
    )
    def test_rejects_non_http_schemes(self, url: str) -> None:
        with pytest.raises(UrlValidationError):
            validate_import_url(url)


class TestValidateImportUrlSsrf:
    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost/recipe",
            "http://127.0.0.1/recipe",
            "http://127.0.0.53/recipe",
            "https://[::1]/recipe",
            "http://0.0.0.0/recipe",
            "http://10.0.0.5/recipe",
            "http://172.16.0.1/recipe",
            "http://192.168.1.10/recipe",
            "http://169.254.169.254/latest/meta-data",  # link-local / cloud metadata
            "https://[fc00::1]/recipe",  # unique local IPv6
            "https://[fe80::1]/recipe",  # link-local IPv6
        ],
    )
    def test_rejects_internal_and_loopback_targets(self, url: str) -> None:
        with pytest.raises(UrlValidationError):
            validate_import_url(url)

    def test_rejects_missing_host(self) -> None:
        with pytest.raises(UrlValidationError):
            validate_import_url("http:///recipe")
