from __future__ import annotations

from typing import Final

IMAGE_SIGNATURES: Final[dict[str, bytes]] = {
    "jpg": b"\xff\xd8\xff",
    "png": b"\x89PNG\r\n\x1a\n",
    "webp": b"RIFF",
}


def sniff_image_ext(data: bytes) -> str | None:
    if data.startswith(IMAGE_SIGNATURES["jpg"]):
        return "jpg"
    if data.startswith(IMAGE_SIGNATURES["png"]):
        return "png"
    if data.startswith(IMAGE_SIGNATURES["webp"]) and b"WEBP" in data[8:16]:
        return "webp"
    return None


def content_type_for_ext(extension: str) -> str:
    return {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(
        extension, "application/octet-stream"
    )


def error_payload(message: str) -> dict[str, str]:
    return {"error": message}
