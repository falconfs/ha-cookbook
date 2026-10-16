from __future__ import annotations

from urllib.parse import urlparse

import aiohttp
import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse

from .const import DOMAIN
from .storage import RecipeStore
from .meal_plan_store import (
    EntryValidationError,
    MealPlanStore,
    SlotValidationError,
)
from .images import sniff_image_ext
from .url_import import (
    DownloadError,
    RecipeImportError,
    UrlValidationError,
    download_html,
    extract_visible_text,
    parse_recipe_html,
)
from .ai_import import (
    AiImportError,
    ai_import_draft,
    ai_regroup_draft,
)


def _get_image_session(hass: HomeAssistant):
    """Return an aiohttp session for image downloads.

    Uses Home Assistant's shared client session when available (preferred),
    falling back to a standalone session. Isolated in a helper so tests can
    inject a fake session.
    """
    try:
        from homeassistant.helpers.aiohttp_client import async_get_clientsession
        return async_get_clientsession(hass)
    except Exception:  # pragma: no cover - fallback for non-HA/test contexts
        return aiohttp.ClientSession()


async def _download_image(session, image_url: str) -> tuple[bytes | None, str | None]:
    """Download + validate an image. Returns (data, None) or (None, error)."""
    parsed = urlparse(image_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None, "Invalid image URL"
    try:
        async with session.get(image_url) as response:
            status = getattr(response, "status", 200)
            if status != 200:
                return None, f"Image download failed ({status})"
            data = await response.read()
    except aiohttp.ClientError as error:
        return None, f"Image download failed: {error}"
    extension = sniff_image_ext(data)
    if extension is None:
        return None, "Unsupported image"
    return data, extension


def _error_response(message: str, error_code: str) -> ServiceResponse:
    return {"error": message, "error_code": error_code}


def _image_error_response(message: str | None) -> ServiceResponse:
    if message == "Invalid image URL":
        error_code = "image_invalid_url"
    elif message == "Unsupported image":
        error_code = "image_unsupported"
    else:
        error_code = "image_download_failed"
    return _error_response(message or "Image download failed", error_code)


def register_services(
    hass: HomeAssistant,
    store: RecipeStore,
    meal_plan_store: MealPlanStore | None = None,
) -> None:
    async def list_recipes(call: ServiceCall) -> ServiceResponse:
        return {"recipes": await store.list_stubs()}

    async def get_recipe(call: ServiceCall) -> ServiceResponse:
        recipe = await store.get(str(call.data["recipe_id"]))
        return {"recipe": recipe}

    async def upsert_recipe(call: ServiceCall) -> ServiceResponse:
        recipe_id = call.data.get("recipe_id")
        resolved_id = await store.upsert(call.data["recipe"], str(recipe_id) if recipe_id else None)
        # Optionally promote a previously staged (tmp) image to this recipe, or
        # remove the existing image. A new image (token) takes precedence over a
        # removal request.
        token = call.data.get("tmp_image_token")
        if token:
            await store.promote_tmp_image(str(token), resolved_id)
        elif call.data.get("remove_image"):
            await store.delete_image(resolved_id)
        return {"recipe_id": resolved_id}

    async def delete_recipe(call: ServiceCall) -> ServiceResponse:
        deleted = await store.delete(str(call.data["recipe_id"]))
        return {"ok": deleted}

    async def fetch_image_from_url(call: ServiceCall) -> ServiceResponse:
        session = _get_image_session(hass)
        data, result = await _download_image(session, str(call.data["image_url"]))
        if data is None:
            return _image_error_response(result)
        recipe_id = str(call.data["recipe_id"])
        await store.save_image(recipe_id, data, result)
        return {"ok": True, "image_ext": result}

    async def fetch_image_to_tmp(call: ServiceCall) -> ServiceResponse:
        session = _get_image_session(hass)
        data, result = await _download_image(session, str(call.data["image_url"]))
        if data is None:
            return _image_error_response(result)
        token = await store.save_tmp_image(data, result)
        return {"ok": True, "token": token, "image_ext": result}

    async def import_recipe_from_url(call: ServiceCall) -> ServiceResponse:
        """Import a recipe natively, using AI only when markup is unusable."""
        url = str(call.data["url"])
        entity_id = call.data.get("ai_task_entity")
        session = _get_image_session(hass)
        try:
            html = await download_html(url, session=session)
        except UrlValidationError:
            return _error_response("This URL cannot be imported.", "import_url_invalid")
        except DownloadError:
            return _error_response("The page could not be downloaded.", "page_download_failed")

        try:
            draft = parse_recipe_html(html, source_url=url)
        except RecipeImportError:
            return await _ai_import_response(html, url, entity_id)

        return {"recipe": draft, "import_method": "native"}

    def _make_ai_generate(entity_id: str | None):
        """Return an async (instructions, structure) -> dict calling ai_task.

        Uses the preferred AI Task entity when no entity_id is given. The
        structured result is returned as a plain dict for validation.
        """
        async def generate(instructions: str, structure: dict):
            service_data: dict = {
                "task_name": "cookbook recipe import",
                "instructions": instructions,
                "structure": structure,
            }
            if entity_id:
                service_data["entity_id"] = entity_id
            response = await hass.services.async_call(
                "ai_task",
                "generate_data",
                service_data,
                blocking=True,
                return_response=True,
            )
            # ai_task.generate_data returns {"conversation_id", "data"}.
            return (response or {}).get("data")

        return generate

    async def _ai_import_response(
        html: str, url: str, entity_id: str | None
    ) -> ServiceResponse:
        try:
            draft = await ai_import_draft(
                extract_visible_text(html),
                source_url=url,
                generate=_make_ai_generate(entity_id),
            )
        except AiImportError:
            return _error_response(
                "The AI could not extract a valid recipe.", "ai_recipe_invalid"
            )
        except Exception:  # noqa: BLE001 - normalize AI/transport failures
            return _error_response("The AI request failed.", "ai_request_failed")
        return {"recipe": draft, "import_method": "ai"}

    async def ai_import_recipe_from_url(call: ServiceCall) -> ServiceResponse:
        """Direct AI URL import for users who explicitly choose the AI action.

        The regular URL import also invokes the same AI pipeline automatically
        when native markup is unusable. This service remains a direct option.
        It never saves; it returns a draft for review.
        """
        url = str(call.data["url"])
        entity_id = call.data.get("ai_task_entity")
        session = _get_image_session(hass)
        try:
            html = await download_html(url, session=session)
        except UrlValidationError:
            return _error_response("This URL cannot be imported.", "import_url_invalid")
        except DownloadError:
            return _error_response("The page could not be downloaded.", "page_download_failed")
        return await _ai_import_response(html, url, entity_id)

    async def ai_regroup_recipe(call: ServiceCall) -> ServiceResponse:
        """AI improvement: re-group an existing recipe's ingredients to steps.

        Takes the current recipe draft, asks the AI to reassign ingredients to
        the steps where they are first used. Never saves; returns
        {"recipe": draft} or {"error": msg}.
        """
        recipe = call.data["recipe"]
        entity_id = call.data.get("ai_task_entity")
        try:
            draft = await ai_regroup_draft(
                recipe, generate=_make_ai_generate(entity_id)
            )
        except AiImportError:
            return _error_response("The AI returned an invalid result.", "ai_result_invalid")
        except Exception:  # noqa: BLE001
            return _error_response("The AI request failed.", "ai_request_failed")
        return {"recipe": draft}

    # --- Weekly recipe calendar (feature-10) -------------------------------

    async def get_meal_plan(call: ServiceCall) -> ServiceResponse:
        if meal_plan_store is None:
            return _error_response("Meal plan storage is not available.", "meal_plan_unavailable")
        return {"plan": await meal_plan_store.get_plan()}

    async def add_meal_plan_entry(call: ServiceCall) -> ServiceResponse:
        if meal_plan_store is None:
            return _error_response("Meal plan storage is not available.", "meal_plan_unavailable")
        try:
            entry = await meal_plan_store.add_entry(
                date=str(call.data["date"]),
                slot_id=str(call.data["slot_id"]),
                recipe_id=str(call.data.get("recipe_id", "")),
                text=str(call.data.get("text", "")),
            )
        except EntryValidationError as error:
            return _error_response(str(error), "invalid_meal_plan_entry")
        return {"entry": entry}

    async def update_meal_plan_entry(call: ServiceCall) -> ServiceResponse:
        if meal_plan_store is None:
            return _error_response("Meal plan storage is not available.", "meal_plan_unavailable")
        try:
            entry = await meal_plan_store.update_entry(
                str(call.data["entry_id"]),
                date=str(call.data["date"]),
                slot_id=str(call.data["slot_id"]),
                recipe_id=str(call.data.get("recipe_id", "")),
                text=str(call.data.get("text", "")),
            )
        except EntryValidationError as error:
            return _error_response(str(error), "invalid_meal_plan_entry")
        return {"entry": entry}

    async def delete_meal_plan_entry(call: ServiceCall) -> ServiceResponse:
        if meal_plan_store is None:
            return _error_response("Meal plan storage is not available.", "meal_plan_unavailable")
        deleted = await meal_plan_store.delete_entry(str(call.data["entry_id"]))
        return {"ok": deleted}

    async def save_meal_plan_slots(call: ServiceCall) -> ServiceResponse:
        if meal_plan_store is None:
            return _error_response("Meal plan storage is not available.", "meal_plan_unavailable")
        try:
            plan = await meal_plan_store.save_slots(list(call.data["slots"]))
        except SlotValidationError as error:
            return _error_response(str(error), "slot_validation_failed")
        return {"plan": plan}

    hass.services.async_register(
        DOMAIN, "list_recipes", list_recipes, supports_response=SupportsResponse.ONLY
    )
    hass.services.async_register(
        DOMAIN, "get_meal_plan", get_meal_plan, supports_response=SupportsResponse.ONLY
    )
    hass.services.async_register(
        DOMAIN,
        "add_meal_plan_entry",
        add_meal_plan_entry,
        schema=vol.Schema(
            {
                vol.Required("date"): str,
                vol.Required("slot_id"): str,
                vol.Optional("recipe_id"): str,
                vol.Optional("text"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "update_meal_plan_entry",
        update_meal_plan_entry,
        schema=vol.Schema(
            {
                vol.Required("entry_id"): str,
                vol.Required("date"): str,
                vol.Required("slot_id"): str,
                vol.Optional("recipe_id"): str,
                vol.Optional("text"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "delete_meal_plan_entry",
        delete_meal_plan_entry,
        schema=vol.Schema({vol.Required("entry_id"): str}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "save_meal_plan_slots",
        save_meal_plan_slots,
        schema=vol.Schema({vol.Required("slots"): list}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "get_recipe",
        get_recipe,
        schema=vol.Schema({vol.Required("recipe_id"): str}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "fetch_image_from_url",
        fetch_image_from_url,
        schema=vol.Schema({vol.Required("recipe_id"): str, vol.Required("image_url"): str}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "fetch_image_to_tmp",
        fetch_image_to_tmp,
        schema=vol.Schema({vol.Required("image_url"): str}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "import_recipe_from_url",
        import_recipe_from_url,
        schema=vol.Schema({
            vol.Required("url"): str,
            vol.Optional("ai_task_entity"): str,
        }),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "ai_import_recipe_from_url",
        ai_import_recipe_from_url,
        schema=vol.Schema({
            vol.Required("url"): str,
            vol.Optional("ai_task_entity"): str,
        }),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "ai_regroup_recipe",
        ai_regroup_recipe,
        schema=vol.Schema({
            vol.Required("recipe"): dict,
            vol.Optional("ai_task_entity"): str,
        }),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "upsert_recipe",
        upsert_recipe,
        schema=vol.Schema({
            vol.Required("recipe"): dict,
            vol.Optional("recipe_id"): str,
            vol.Optional("tmp_image_token"): str,
            vol.Optional("remove_image"): bool,
        }),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        "delete_recipe",
        delete_recipe,
        schema=vol.Schema({vol.Required("recipe_id"): str}),
        supports_response=SupportsResponse.ONLY,
    )
