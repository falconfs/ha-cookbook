from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigEntry
from homeassistant.loader import async_get_loaded_integration
from homeassistant.helpers.typing import ConfigType

from .const import DOMAIN, MEAL_PLAN_PATH, STORAGE_PATH
from .http_views import CookbookImageView, CookbookTmpImageView, CookbookTmpUploadView
from .meal_plan_store import MealPlanStore
from .services import register_services
from .storage import RecipeStore


async def _async_register_frontend(hass: HomeAssistant, version: str) -> None:
    frontend_dir = Path(__file__).parent / "frontend"
    frontend_url = f"/{DOMAIN}/frontend/{version}"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(frontend_url, str(frontend_dir), True)]
    )
    frontend.add_extra_js_url(hass, f"{frontend_url}/cookbook-card.js")


async def _async_setup_runtime(hass: HomeAssistant) -> None:
    if DOMAIN in hass.data:
        return

    root = Path(hass.config.path(STORAGE_PATH))
    store = RecipeStore(root)
    meal_plan_store = MealPlanStore(Path(hass.config.path(MEAL_PLAN_PATH)))
    register_services(hass, store, meal_plan_store)
    hass.http.register_view(CookbookImageView(store))
    hass.http.register_view(CookbookTmpImageView(store))
    hass.http.register_view(CookbookTmpUploadView(store))
    version = async_get_loaded_integration(hass, DOMAIN).version
    if version is None:
        raise RuntimeError("The Cookbook integration manifest must define a version")
    await _async_register_frontend(hass, version)
    hass.data[DOMAIN] = store


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    await _async_setup_runtime(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    await _async_setup_runtime(hass)
    return True
