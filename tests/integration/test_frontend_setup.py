import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.components.http import StaticPathConfig

from custom_components.cookbook import _async_register_frontend
from custom_components.cookbook.const import DOMAIN


def test_registers_versioned_frontend_assets_and_module():
    hass = SimpleNamespace(
        data={DATA_EXTRA_MODULE_URL: set()},
        http=SimpleNamespace(async_register_static_paths=AsyncMock()),
    )

    asyncio.run(_async_register_frontend(hass, "1.2.3"))

    frontend_dir = Path(__file__).parents[2] / "custom_components" / DOMAIN / "frontend"
    hass.http.async_register_static_paths.assert_awaited_once_with(
        [StaticPathConfig(f"/{DOMAIN}/frontend/1.2.3", str(frontend_dir), True)]
    )
    assert hass.data[DATA_EXTRA_MODULE_URL] == {
        f"/{DOMAIN}/frontend/1.2.3/cookbook-card.js"
    }
