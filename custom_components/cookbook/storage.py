from __future__ import annotations

import json
import uuid
from pathlib import Path

import anyio


class RecipeStore:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._locks: dict[str, anyio.Lock] = {}
        self._tmp_root = root / ".tmp_images"

    def _lock_for(self, recipe_id: str) -> anyio.Lock:
        if recipe_id not in self._locks:
            self._locks[recipe_id] = anyio.Lock()
        return self._locks[recipe_id]

    def _recipe_path(self, recipe_id: str) -> Path:
        return self._root / recipe_id / "recipe.json"

    async def get(self, recipe_id: str) -> dict[str, object] | None:
        return await anyio.to_thread.run_sync(self._read_recipe, recipe_id)

    def _read_recipe(self, recipe_id: str) -> dict[str, object] | None:
        path = self._recipe_path(recipe_id)
        if not path.is_file():
            return None
        recipe = json.loads(path.read_text(encoding="utf-8"))
        recipe["image_mtime"] = self._image_mtime(recipe_id)
        return recipe

    def _image_mtime(self, recipe_id: str) -> int | None:
        """mtime (seconds) of the recipe's stored image, or None if absent.
        Used by the card as an image cache-buster so a replaced image shows up
        without a hard reload."""
        path = self._image_path(recipe_id)
        if path is None:
            return None
        try:
            return int(path.stat().st_mtime)
        except OSError:
            return None

    async def upsert(self, recipe: dict[str, object], recipe_id: str | None = None) -> str:
        resolved_id = recipe_id or await self.next_id()
        async with self._lock_for(resolved_id):
            payload = {**recipe, "id": resolved_id}
            await anyio.to_thread.run_sync(
                self._write_recipe,
                resolved_id,
                payload,
            )
        return resolved_id

    def _write_recipe(self, recipe_id: str, recipe: dict[str, object]) -> None:
        recipe_dir = self._root / recipe_id
        recipe_dir.mkdir(parents=True, exist_ok=True)
        # `image_mtime` is a derived, read-only field — never persist it.
        payload = {key: value for key, value in recipe.items() if key != "image_mtime"}
        temporary = recipe_dir / "recipe.json.tmp"
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        temporary.replace(self._recipe_path(recipe_id))

    async def save_import_html(self, recipe_id: str, html: str) -> None:
        """Store the downloaded raw HTML as an audit artifact for a recipe.

        Mirrors upstream Nextcloud Cookbook's ``import.html``. Written
        atomically into the recipe directory.
        """
        async with self._lock_for(recipe_id):
            await anyio.to_thread.run_sync(self._write_import_html, recipe_id, html)

    def _write_import_html(self, recipe_id: str, html: str) -> None:
        recipe_dir = self._root / recipe_id
        recipe_dir.mkdir(parents=True, exist_ok=True)
        temporary = recipe_dir / "import.html.tmp"
        temporary.write_text(html, encoding="utf-8")
        temporary.replace(recipe_dir / "import.html")

    async def delete(self, recipe_id: str) -> bool:
        async with self._lock_for(recipe_id):
            return await anyio.to_thread.run_sync(self._delete_recipe, recipe_id)

    def _delete_recipe(self, recipe_id: str) -> bool:
        recipe_dir = self._root / recipe_id
        if not recipe_dir.exists():
            return False
        for path in recipe_dir.iterdir():
            path.unlink()
        recipe_dir.rmdir()
        return True

    async def next_id(self) -> str:
        return await anyio.to_thread.run_sync(self._next_id)

    def _next_id(self) -> str:
        self._root.mkdir(parents=True, exist_ok=True)
        ids = [int(path.name) for path in self._root.iterdir() if path.name.isdigit()]
        return str(max(ids, default=0) + 1)

    async def list_stubs(self) -> list[dict[str, object]]:
        return await anyio.to_thread.run_sync(self._list_stubs)

    def _list_stubs(self) -> list[dict[str, object]]:
        self._root.mkdir(parents=True, exist_ok=True)
        result: list[dict[str, object]] = []
        recipe_dirs = sorted(
            (path for path in self._root.iterdir() if path.name.isdigit()),
            key=lambda path: int(path.name),
        )
        for recipe_dir in recipe_dirs:
            recipe = self._read_recipe(recipe_dir.name)
            if recipe is None:
                continue
            result.append(
                {
                    "id": str(recipe.get("id", recipe_dir.name)),
                    "name": recipe.get("name", ""),
                    "url": recipe.get("url", ""),
                    "recipeCategory": recipe.get("recipeCategory", ""),
                    "keywords": recipe.get("keywords", ""),
                    "_ha_rating": recipe.get("_ha_rating"),
                    "dateCreated": recipe.get("dateCreated", ""),
                    "dateModified": recipe.get("dateModified", ""),
                    "image_mtime": self._image_mtime(recipe_dir.name),
                }
            )
        return result

    async def image_path(self, recipe_id: str) -> Path | None:
        return await anyio.to_thread.run_sync(self._image_path, recipe_id)

    def _image_path(self, recipe_id: str) -> Path | None:
        recipe_dir = self._root / recipe_id
        for extension in ("jpg", "png", "webp"):
            path = recipe_dir / f"image.{extension}"
            if path.is_file():
                return path
        return None

    async def save_image(self, recipe_id: str, data: bytes, extension: str) -> None:
        async with self._lock_for(recipe_id):
            await anyio.to_thread.run_sync(
                self._write_image,
                recipe_id,
                data,
                extension,
            )

    def _write_image(self, recipe_id: str, data: bytes, extension: str) -> None:
        recipe_dir = self._root / recipe_id
        recipe_dir.mkdir(parents=True, exist_ok=True)
        target = recipe_dir / f"image.{extension}"
        # Remove any previously stored image so a new one always replaces the
        # old one, even when the file extension differs (e.g. jpg → png).
        for existing in ("jpg", "png", "webp"):
            if existing != extension:
                other = recipe_dir / f"image.{existing}"
                if other.exists():
                    other.unlink()
        if target.exists() and target.read_bytes() == data:
            return
        temporary = recipe_dir / f"image.{extension}.tmp"
        temporary.write_bytes(data)
        temporary.replace(target)

    async def delete_image(self, recipe_id: str) -> bool:
        async with self._lock_for(recipe_id):
            return await anyio.to_thread.run_sync(self._delete_image, recipe_id)

    def _delete_image(self, recipe_id: str) -> bool:
        recipe_dir = self._root / recipe_id
        removed = False
        for extension in ("jpg", "png", "webp"):
            path = recipe_dir / f"image.{extension}"
            if path.exists():
                path.unlink()
                removed = True
        return removed

    # --- Temporary image staging (preview before a recipe is saved) ---

    async def save_tmp_image(self, data: bytes, extension: str) -> str:
        return await anyio.to_thread.run_sync(self._save_tmp_image, data, extension)

    def _save_tmp_image(self, data: bytes, extension: str) -> str:
        self._tmp_root.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        target = self._tmp_root / f"{token}.{extension}"
        temporary = self._tmp_root / f"{token}.{extension}.part"
        temporary.write_bytes(data)
        temporary.replace(target)
        return token

    async def tmp_image_path(self, token: str) -> Path | None:
        return await anyio.to_thread.run_sync(self._tmp_image_path, token)

    def _tmp_image_path(self, token: str) -> Path | None:
        if not token or not self._tmp_root.exists():
            return None
        for path in self._tmp_root.iterdir():
            if path.stem == token and path.is_file():
                return path
        return None

    async def promote_tmp_image(self, token: str, recipe_id: str) -> str | None:
        source = await self.tmp_image_path(token)
        if source is None:
            return None
        extension = source.suffix.lstrip(".")
        data = await anyio.to_thread.run_sync(source.read_bytes)
        await self.save_image(recipe_id, data, extension)
        await anyio.to_thread.run_sync(source.unlink)
        return extension
