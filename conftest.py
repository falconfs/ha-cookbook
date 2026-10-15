"""Root pytest scaffolding for the cookbook card.

Home Assistant, voluptuous and anyio are not installed in the card's dev
environment. Pure-logic unit tests (URL import validation, parsers, v6
normalization) must not require the full HA runtime. This conftest registers
minimal stub modules before pytest imports the HA custom-component package, so
tests that live inside that package do not pull in the real framework.

Only names referenced at import time by the package are stubbed.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

# Make the integration package importable as custom_components.cookbook so
# service-level tests can import it (with the HA stubs installed below).
_REPOSITORY_ROOT = Path(__file__).parent
if str(_REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPOSITORY_ROOT))


def _ensure_module(name: str) -> types.ModuleType:
    module = sys.modules.get(name)
    if module is None:
        module = types.ModuleType(name)
        sys.modules[name] = module
    return module


def _install_stubs() -> None:
    if "homeassistant" in sys.modules:
        return

    _ensure_module("homeassistant")

    core = _ensure_module("homeassistant.core")
    for attr in ("HomeAssistant", "ServiceCall", "ServiceResponse"):
        setattr(core, attr, type(attr, (), {}))

    class _SupportsResponse:
        ONLY = "only"

    core.SupportsResponse = _SupportsResponse

    loader = _ensure_module("homeassistant.loader")
    loader.async_get_loaded_integration = lambda hass, domain: None

    config_entries = _ensure_module("homeassistant.config_entries")
    config_entries.ConfigEntry = type("ConfigEntry", (), {})

    helpers = _ensure_module("homeassistant.helpers")
    typing_mod = _ensure_module("homeassistant.helpers.typing")
    typing_mod.ConfigType = dict
    helpers.typing = typing_mod

    aiohttp_client = _ensure_module("homeassistant.helpers.aiohttp_client")
    aiohttp_client.async_get_clientsession = lambda hass: None

    components = _ensure_module("homeassistant.components")
    http = _ensure_module("homeassistant.components.http")
    http.HomeAssistantView = type("HomeAssistantView", (), {})

    class _StaticPathConfig:
        def __init__(self, url_path: str, path: str, cache_headers: bool) -> None:
            self.url_path = url_path
            self.path = path
            self.cache_headers = cache_headers

        def __eq__(self, other: object) -> bool:
            return (
                isinstance(other, _StaticPathConfig)
                and self.url_path == other.url_path
                and self.path == other.path
                and self.cache_headers == other.cache_headers
            )

    http.StaticPathConfig = _StaticPathConfig
    components.http = http

    frontend = _ensure_module("homeassistant.components.frontend")
    frontend.DATA_EXTRA_MODULE_URL = "frontend_extra_module_url"
    frontend.add_extra_js_url = lambda hass, url: hass.data[
        frontend.DATA_EXTRA_MODULE_URL
    ].add(url)
    components.frontend = frontend

    if "voluptuous" not in sys.modules:
        vol = _ensure_module("voluptuous")
        vol.Schema = lambda *args, **kwargs: (lambda value: value)
        vol.Required = lambda key, **kwargs: key
        vol.Optional = lambda key, **kwargs: key

    if "anyio" not in sys.modules:
        _install_anyio_stub()


def _install_anyio_stub() -> None:
    """A minimal but functional anyio stub (Lock + to_thread.run_sync).

    anyio is not installed in the card's dev environment. This stub is enough to
    exercise RecipeStore against a real temporary directory in unit tests.
    """
    import asyncio

    anyio = _ensure_module("anyio")

    class _Lock:
        def __init__(self) -> None:
            self._lock = asyncio.Lock()

        async def __aenter__(self) -> "_Lock":
            await self._lock.acquire()
            return self

        async def __aexit__(self, *exc: object) -> None:
            self._lock.release()

    async def _run_sync(func, *args):
        return func(*args)

    to_thread = _ensure_module("anyio.to_thread")
    to_thread.run_sync = _run_sync

    anyio.Lock = _Lock
    anyio.to_thread = to_thread


_install_stubs()
