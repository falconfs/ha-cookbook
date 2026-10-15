from __future__ import annotations

from homeassistant.components.http import HomeAssistantView
from aiohttp import web

from .images import content_type_for_ext, error_payload, sniff_image_ext
from .storage import RecipeStore


class CookbookImageView(HomeAssistantView):
    url = "/api/cookbook/recipes/{recipe_id}/image"
    name = "api:cookbook:image"
    requires_auth = False

    def __init__(self, store: RecipeStore) -> None:
        self._store = store

    async def get(self, request: web.Request, recipe_id: str) -> web.Response:
        image = await self._store.image_path(recipe_id)
        if image is None:
            return web.json_response(error_payload("Image not found"), status=404)
        return web.FileResponse(image, headers={"Content-Type": content_type_for_ext(image.suffix[1:])})

    async def post(self, request: web.Request, recipe_id: str) -> web.Response:
        reader = await request.multipart()
        field = await reader.next()
        if field is None:
            return web.json_response(error_payload("Image is required"), status=400)
        data = await field.read()
        extension = sniff_image_ext(data)
        if extension is None:
            return web.json_response(error_payload("Unsupported image"), status=415)
        await self._store.save_image(recipe_id, data, extension)
        return web.json_response({"ok": True, "image_ext": extension})


class CookbookTmpImageView(HomeAssistantView):
    """Stage an image in a temporary area for same-origin preview before the
    recipe is saved. POST uploads a file → returns a token; GET serves it."""

    url = "/api/cookbook/tmp/{token}"
    name = "api:cookbook:tmp"
    requires_auth = False

    def __init__(self, store: RecipeStore) -> None:
        self._store = store

    async def get(self, request: web.Request, token: str) -> web.Response:
        image = await self._store.tmp_image_path(token)
        if image is None:
            return web.json_response(error_payload("Image not found"), status=404)
        return web.FileResponse(
            image, headers={"Content-Type": content_type_for_ext(image.suffix[1:])}
        )


class CookbookTmpUploadView(HomeAssistantView):
    """POST a file → stage in tmp → return {token, image_ext}."""

    url = "/api/cookbook/tmp"
    name = "api:cookbook:tmp-upload"
    requires_auth = False

    def __init__(self, store: RecipeStore) -> None:
        self._store = store

    async def post(self, request: web.Request) -> web.Response:
        reader = await request.multipart()
        field = await reader.next()
        if field is None:
            return web.json_response(error_payload("Image is required"), status=400)
        data = await field.read()
        extension = sniff_image_ext(data)
        if extension is None:
            return web.json_response(error_payload("Unsupported image"), status=415)
        token = await self._store.save_tmp_image(data, extension)
        return web.json_response({"ok": True, "token": token, "image_ext": extension})
