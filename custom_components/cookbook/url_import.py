"""Native URL recipe import helpers (feature-07).

Pure, Home-Assistant-independent logic for the native JSON-LD / microdata
import path. Keeping this free of the HA runtime lets the security-critical
URL validation and (later) the parsers/normalization be unit-tested in
isolation, mirroring the isolated helpers in ``images.py``.

The first unit is URL validation including SSRF protection (AC5): only
``http``/``https`` URLs with a real, public host are accepted. Loopback,
private, link-local and unique-local targets are rejected before any network
access happens.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

_ALLOWED_SCHEMES = {"http", "https"}
_JSONLD_TYPE = "application/ld+json"


class UrlValidationError(ValueError):
    """Raised when an import URL is malformed or points at a blocked target."""


def _extract_host(netloc: str) -> str:
    """Return the bare host from a URL netloc, without userinfo or port.

    IPv6 hosts are wrapped in brackets in a netloc (e.g. ``[::1]:8080``); the
    brackets are stripped so the value can be parsed as an IP address.
    """
    host = netloc
    if "@" in host:
        host = host.rsplit("@", 1)[1]
    if host.startswith("["):
        # IPv6 literal: [addr] or [addr]:port
        closing = host.find("]")
        if closing == -1:
            return ""
        return host[1:closing]
    # IPv4 / hostname: strip an optional :port
    if ":" in host:
        host = host.rsplit(":", 1)[0]
    return host


def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Report whether an IP is an internal/unsafe SSRF target."""
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_import_url(url: str) -> str:
    """Validate an import URL and return it unchanged when it is safe.

    Raises:
        UrlValidationError: if the scheme is not http/https, the host is
            missing, or the host resolves to a blocked internal target.
    """
    if not isinstance(url, str) or not url:
        raise UrlValidationError("Import URL must be a non-empty string")

    parsed = urlparse(url)

    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise UrlValidationError(
            f"Unsupported URL scheme: {parsed.scheme or '(none)'}"
        )

    host = _extract_host(parsed.netloc)
    if not host:
        raise UrlValidationError("Import URL must include a host")

    lowered = host.lower()
    if lowered == "localhost" or lowered.endswith(".localhost"):
        raise UrlValidationError("Import URL must not target localhost")

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # Not a literal IP; a public hostname is accepted here. DNS-level SSRF
        # protection (resolving the hostname and re-checking) happens in the
        # download layer, isolated from this pure validator.
        return url

    if _is_blocked_ip(ip):
        raise UrlValidationError("Import URL must not target an internal address")

    return url


class _JsonLdCollector(HTMLParser):
    """Collect the raw text of every ``application/ld+json`` script block."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._in_jsonld = False
        self._buffer: list[str] = []

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag.lower() != "script":
            return
        attr_map = {key.lower(): (value or "") for key, value in attrs}
        if attr_map.get("type", "").strip().lower() == _JSONLD_TYPE:
            self._in_jsonld = True
            self._buffer = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._in_jsonld:
            self.blocks.append("".join(self._buffer))
            self._in_jsonld = False
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._in_jsonld:
            self._buffer.append(data)


def _type_matches_recipe(node: Any) -> bool:
    raw_type = node.get("@type") if isinstance(node, dict) else None
    if isinstance(raw_type, str):
        return raw_type == "Recipe"
    if isinstance(raw_type, list):
        return "Recipe" in raw_type
    return False


def _find_recipe(node: Any) -> dict[str, Any] | None:
    """Return the first Recipe dict found within a parsed JSON-LD value."""
    if isinstance(node, dict):
        if _type_matches_recipe(node):
            return node
        graph = node.get("@graph")
        if isinstance(graph, list):
            return _find_recipe(graph)
        # Some sites emit @graph as an object keyed by numeric strings
        # ({"0": {...}, "7": {...}}) instead of a JSON array.
        if isinstance(graph, dict):
            return _find_recipe(list(graph.values()))
        return None
    if isinstance(node, list):
        for item in node:
            found = _find_recipe(item)
            if found is not None:
                return found
    return None


def extract_jsonld_recipe(html: str) -> dict[str, Any] | None:
    """Extract the first schema.org Recipe from JSON-LD in an HTML document.

    Supports a direct Recipe object, an array of objects and an ``@graph``
    container, matching the upstream Nextcloud Cookbook order. The first Recipe
    encountered (per block, blocks in document order) wins. Malformed JSON in a
    block is ignored and does not hide a valid Recipe in another block. Returns
    ``None`` when no Recipe is present.
    """
    collector = _JsonLdCollector()
    collector.feed(html)
    for block in collector.blocks:
        text = block.strip()
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            continue
        recipe = _find_recipe(parsed)
        if recipe is not None:
            return recipe
    return None


def _as_text(value: Any) -> str:
    """Best-effort conversion of a schema.org scalar/object to a string."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("text", "name", "url", "@value"):
            inner = value.get(key)
            if isinstance(inner, str) and inner.strip():
                return inner.strip()
    return ""


def _first(value: Any) -> Any:
    """Return the first item of a list, or the value itself."""
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _normalize_keywords(value: Any) -> str:
    if isinstance(value, list):
        return ",".join(_as_text(item) for item in value if _as_text(item))
    return _as_text(value)


def _normalize_category(value: Any) -> str:
    return _as_text(_first(value))


def _normalize_yield(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    candidate = _as_text(_first(value))
    if not candidate:
        return None
    number = ""
    for char in candidate:
        if char.isdigit():
            number += char
        elif number:
            break
    return int(number) if number else None


def _normalize_image(value: Any) -> str:
    first = _first(value)
    if isinstance(first, str):
        return first.strip()
    if isinstance(first, dict):
        url = first.get("url")
        if isinstance(url, str):
            return url.strip()
    return ""


# Recognised cooking units (lowercase). A token after the amount only becomes
# the unit if it is in this set; otherwise it is part of the name. Excludes
# "Rezept" and similar non-units by simply not listing them.
_UNITS: frozenset[str] = frozenset(
    {
        "g", "kg", "mg", "l", "ml", "cl", "dl",
        "el", "tl", "msp",
        "prise", "prisen", "stück", "stücke", "stk",
        "dose", "dosen", "packung", "packungen", "pkg", "päckchen",
        "bund", "bünde", "zehe", "zehen", "scheibe", "scheiben",
        "zweig", "zweige", "blatt", "blätter", "kopf", "köpfe",
        "tasse", "tassen", "becher", "glas", "gläser", "flasche", "flaschen",
        "handvoll", "tropfen", "würfel", "kugel", "kugeln", "stange", "stangen",
        "cup", "cups", "tbsp", "tsp", "oz", "lb",
    }
)

# A leading quantity: integer, decimal (dot or comma), fraction, or a range
# using -, – or "bis". Examples: 300, 0.5, 1,5, 1/2, 2-3.
_QUANTITY_RE = re.compile(
    r"^\s*(\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?|\d+\s*/\s*\d+)\s+"
)
_NOTE_RE = re.compile(r"\(([^)]*)\)")


def parse_ingredient(text: str) -> dict[str, str]:
    """Split a free-form ingredient string into {name, amount, unit, note}.

    A leading quantity becomes ``amount``; a following recognised unit becomes
    ``unit``; the remainder is the ``name``; the first (...) group becomes
    ``note``. Missing parts are empty strings.
    """
    result = {"name": "", "amount": "", "unit": "", "note": ""}
    if not isinstance(text, str):
        return result
    working = text.strip()
    if not working:
        return result

    # 1. Pull out the first parenthesised note, if any.
    note_match = _NOTE_RE.search(working)
    if note_match:
        result["note"] = note_match.group(1).strip()
        working = (working[: note_match.start()] + working[note_match.end() :]).strip()

    # 2. Leading quantity -> amount.
    qty_match = _QUANTITY_RE.match(working)
    if qty_match:
        result["amount"] = re.sub(r"\s+", "", qty_match.group(1))
        working = working[qty_match.end() :].strip()

    # 3. First token -> unit only if recognised.
    if working:
        parts = working.split(None, 1)
        first = parts[0]
        if first.lower().rstrip(".") in _UNITS:
            result["unit"] = first.rstrip(".")
            working = parts[1].strip() if len(parts) > 1 else ""

    result["name"] = working
    return result


def _ingredient(name: str) -> dict[str, str]:
    return parse_ingredient(name)


def _normalize_instruction_text(value: Any) -> str:
    return _as_text(value)


# Tokens that carry no matching signal: quantities, common cooking units and
# filler words. Kept small and language-light; the goal is a best-effort first
# guess that the user corrects in the editor.
_STOPWORDS: frozenset[str] = frozenset(
    {
        "g", "kg", "mg", "l", "ml", "el", "tl", "cl", "dl",
        "prise", "prisen", "stück", "stücke", "dose", "dosen", "pkg",
        "packung", "packungen", "bund", "zehe", "zehen", "scheibe",
        "scheiben", "tasse", "tassen", "esslöffel", "teelöffel",
        "etwas", "ca", "nach", "geschmack", "frisch", "frische", "frischer",
        "und", "oder", "von", "der", "die", "das", "ein", "eine", "einer",
        "cup", "cups", "tbsp", "tsp", "oz", "lb", "of", "the", "a", "an",
        "some", "fresh", "to", "taste",
    }
)

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def _significant_words(ingredient_name: str) -> list[str]:
    """Return the meaningful lowercase words of an ingredient name.

    Strips numbers and known unit/filler tokens so that "250 g Mehl" yields
    ["mehl"] and can be matched against a step text.
    """
    words = [w.lower() for w in _WORD_RE.findall(ingredient_name)]
    return [w for w in words if w not in _STOPWORDS]


def _mentions_word(text_lower: str, word: str) -> bool:
    """Whole-word (Unicode) match of ``word`` inside an already-lowered text."""
    return re.search(rf"(?<!\w){re.escape(word)}(?!\w)", text_lower) is not None


def _first_step_for_ingredient(
    ingredient_name: str, step_texts_lower: list[str]
) -> int | None:
    """Index of the first step whose text mentions any significant word of the
    ingredient, or ``None`` if no step mentions it."""
    words = _significant_words(ingredient_name)
    if not words:
        return None
    for index, text_lower in enumerate(step_texts_lower):
        if any(_mentions_word(text_lower, word) for word in words):
            return index
    return None


def _collect_step_texts(raw_instructions: Any) -> list[str]:
    texts: list[str] = []
    if isinstance(raw_instructions, str):
        text = raw_instructions.strip()
        if text:
            texts.append(text)
    elif isinstance(raw_instructions, list):
        for item in raw_instructions:
            # HowToSection wraps a list of HowToSteps under itemListElement.
            if isinstance(item, dict) and isinstance(item.get("itemListElement"), list):
                for sub in item["itemListElement"]:
                    text = _normalize_instruction_text(sub)
                    if text:
                        texts.append(text)
                continue
            text = _normalize_instruction_text(item)
            if text:
                texts.append(text)
    return texts


def _normalize_steps(
    raw_instructions: Any, ingredients: list[str]
) -> list[dict[str, Any]]:
    """Build v6 structured steps with a heuristic ingredient-to-step mapping.

    schema.org gives no ingredient-to-step mapping. Each ingredient is attached
    to the first step whose instruction text mentions its name ("newly
    introduced" semantics). Ingredients with no textual match fall back to the
    first step, so no ingredient is lost. The user re-groups in the editor.
    """
    texts = _collect_step_texts(raw_instructions)
    names = [name for name in ingredients if name]

    if not texts:
        if names:
            return [
                {"ingredients": [_ingredient(n) for n in names], "instruction": ""}
            ]
        return []

    texts_lower = [t.lower() for t in texts]
    buckets: list[list[str]] = [[] for _ in texts]
    for name in names:
        target = _first_step_for_ingredient(name, texts_lower)
        buckets[target if target is not None else 0].append(name)

    return [
        {
            "ingredients": [_ingredient(n) for n in buckets[index]],
            "instruction": text,
        }
        for index, text in enumerate(texts)
    ]


def _is_group_header(text: str) -> bool:
    """True for section labels embedded in the ingredient list.

    Recipe sites often add group headers like "Für den Belag:" or "For the
    sauce:" as plain recipeIngredient entries. They carry no quantity and end
    with a colon; real ingredients without a quantity (e.g. "Salz") do not.
    """
    stripped = text.strip()
    if not stripped.endswith(":"):
        return False
    # If a leading quantity is present, it is an ingredient, not a header.
    return not parse_ingredient(stripped)["amount"]


def _normalize_ingredient_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        if isinstance(value, str) and value.strip():
            return [] if _is_group_header(value) else [value.strip()]
        return []
    result: list[str] = []
    for item in value:
        text = _as_text(item)
        if text and not _is_group_header(text):
            result.append(text)
    return result


def normalize_to_v6(
    source: dict[str, Any], *, source_url: str, now: str | None = None
) -> dict[str, Any]:
    """Normalize a schema.org Recipe into the local v6 recipe shape.

    Optional fields absent from the source get valid v6 defaults ("" or null),
    never invalid placeholders. The import URL is written to ``url`` and the
    recipe is marked as a v6 draft for the editor review.

    ``dateCreated`` and ``dateModified`` are set to the import time (``now``,
    ISO-8601; defaults to the current UTC time). ``datePublished`` is taken from
    the source page when present, otherwise ``None``.
    """
    ingredients = _normalize_ingredient_list(source.get("recipeIngredient"))
    steps = _normalize_steps(source.get("recipeInstructions"), ingredients)
    timestamp = now or datetime.now(timezone.utc).isoformat()

    keywords = _normalize_keywords(source.get("keywords"))
    raw_category = source.get("recipeCategory")
    # When the source has no keywords but recipeCategory is a multi-value list,
    # keep the first entry as the category and use the rest as tags.
    if not keywords and isinstance(raw_category, list) and len(raw_category) > 1:
        keywords = ",".join(
            _as_text(item) for item in raw_category[1:] if _as_text(item)
        )

    recipe: dict[str, Any] = {
        "name": _as_text(source.get("name")),
        "description": _as_text(source.get("description")),
        "@context": "http://schema.org",
        "@type": "Recipe",
        "recipeCategory": _normalize_category(raw_category),
        "keywords": keywords,
        "recipeYield": _normalize_yield(source.get("recipeYield")),
        "recipeInstructions": steps,
        "tool": [],
        "image": _normalize_image(source.get("image")),
        "url": source_url,
        "dateCreated": timestamp,
        "dateModified": timestamp,
        "datePublished": _as_text(source.get("datePublished")) or None,
        "prepTime": _as_text(source.get("prepTime")) or None,
        "cookTime": _as_text(source.get("cookTime")) or None,
        "totalTime": _as_text(source.get("totalTime")) or None,
        "_cookbook_schema_version": 6,
    }

    # Preserve the author from the source verbatim (string, object or list).
    # Only added when present so an absent author is not stored as a placeholder.
    author = source.get("author")
    if author:
        recipe["author"] = author

    return recipe


# --- Microdata parser -------------------------------------------------------
# A light DOM tree built from html.parser so we can reason about itemscope /
# itemprop nesting the way the upstream DOMXPath parser does. Standard library
# only; no new dependency.

_VOID_TAGS: frozenset[str] = frozenset(
    {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }
)

_RECIPE_ITEMTYPES: frozenset[str] = frozenset(
    {
        "http://schema.org/Recipe",
        "https://schema.org/Recipe",
        "http://www.schema.org/Recipe",
        "https://www.schema.org/Recipe",
    }
)

_INGREDIENT_PROPS = ("recipeIngredient", "ingredients")
_INSTRUCTION_PROPS = ("recipeInstructions", "instructions", "steps", "guide")
_IMAGE_PROPS = ("image", "images", "thumbnail")


class _Node:
    __slots__ = ("tag", "attrs", "children", "parent", "text_parts")

    def __init__(self, tag: str, attrs: dict[str, str], parent: "_Node | None"):
        self.tag = tag
        self.attrs = attrs
        self.children: list[_Node] = []
        self.parent = parent
        self.text_parts: list[str] = []

    def text(self) -> str:
        parts: list[str] = []

        def walk(node: "_Node") -> None:
            parts.extend(node.text_parts)
            for child in node.children:
                walk(child)

        walk(self)
        return " ".join(" ".join(parts).split())


class _DomBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("#root", {}, None)
        self._stack: list[_Node] = [self.root]

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attr_map = {key.lower(): (value or "") for key, value in attrs}
        node = _Node(tag.lower(), attr_map, self._stack[-1])
        self._stack[-1].children.append(node)
        if tag.lower() not in _VOID_TAGS:
            self._stack.append(node)

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        attr_map = {key.lower(): (value or "") for key, value in attrs}
        node = _Node(tag.lower(), attr_map, self._stack[-1])
        self._stack[-1].children.append(node)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _VOID_TAGS:
            return
        for depth in range(len(self._stack) - 1, 0, -1):
            if self._stack[depth].tag == tag:
                del self._stack[depth:]
                return

    def handle_data(self, data: str) -> None:
        if data.strip():
            self._stack[-1].text_parts.append(data)


def _iter_descendants(node: _Node):
    for child in node.children:
        yield child
        yield from _iter_descendants(child)


def _find_first_recipe_node(root: _Node) -> _Node | None:
    for node in _iter_descendants(root):
        if "itemscope" in node.attrs and node.attrs.get("itemtype", "") in _RECIPE_ITEMTYPES:
            return node
    return None


def _has_intermediate_itemscope(node: _Node, recipe: _Node) -> bool:
    """True if there is an itemscope ancestor strictly between node and recipe.

    Mirrors upstream ``count(ancestor::*[@itemscope]) = 1`` so nested sub-items
    do not leak their properties into the top-level recipe.
    """
    parent = node.parent
    while parent is not None and parent is not recipe:
        if "itemscope" in parent.attrs:
            return True
        parent = parent.parent
    return False


def _direct_prop_nodes(recipe: _Node, prop: str) -> list[_Node]:
    result: list[_Node] = []
    for node in _iter_descendants(recipe):
        if node.attrs.get("itemprop") == prop and not _has_intermediate_itemscope(node, recipe):
            result.append(node)
    return result


def _extract_value(node: _Node, attributes: tuple[str, ...]) -> str | None:
    for attr in attributes:
        value = node.attrs.get(attr)
        if value:
            return value.strip()
    text = node.text()
    return text if text else None


def _search_multiple(
    recipe: _Node,
    properties: tuple[str, ...],
    attributes: tuple[str, ...],
) -> list[str]:
    for prop in properties:
        values = [
            v
            for node in _direct_prop_nodes(recipe, prop)
            if (v := _extract_value(node, attributes)) is not None
        ]
        if values:
            return values
    return []


def _search_simple(recipe: _Node, prop: str) -> str | None:
    values = _search_multiple(recipe, (prop,), ("content",))
    if not values:
        return None
    return values[0] if len(values) == 1 else ", ".join(values)


def extract_microdata_recipe(html: str) -> dict[str, Any] | None:
    """Extract the first schema.org Recipe expressed as HTML microdata.

    Returns a raw schema.org-like dict (converted to v6 by normalize_to_v6), or
    None when no Recipe itemscope is present. Follows the upstream property
    order and the <p>-element instruction fixup.
    """
    builder = _DomBuilder()
    builder.feed(html)
    recipe_node = _find_first_recipe_node(builder.root)
    if recipe_node is None:
        return None

    recipe: dict[str, Any] = {"@type": "Recipe", "@context": "http://schema.org"}

    for prop in ("name", "keywords", "recipeYield"):
        value = _search_simple(recipe_node, prop)
        if value is not None:
            recipe[prop] = value

    description = _search_simple(recipe_node, "description")
    if description is not None:
        recipe["description"] = description

    images = _search_multiple(recipe_node, _IMAGE_PROPS, ("src", "content"))
    if images:
        recipe["image"] = images[0] if len(images) == 1 else images

    ingredients = _search_multiple(recipe_node, _INGREDIENT_PROPS, ("content",))
    if ingredients:
        recipe["recipeIngredient"] = ingredients

    instructions = _search_multiple(recipe_node, _INSTRUCTION_PROPS, ("content",))
    if not instructions:
        instructions = [
            text
            for node in _iter_descendants(recipe_node)
            if node.tag == "p" and (text := node.text())
        ]
    if instructions:
        recipe["recipeInstructions"] = instructions

    return recipe


# --- Server-side HTML download with DNS-level SSRF re-check ------------------

class DownloadError(RuntimeError):
    """Raised when a page cannot be downloaded (non-2xx, network failure)."""


# Browser-like headers, mirroring the upstream Nextcloud Cookbook downloader so
# that recipe sites serve the same HTML a real browser would receive.
_BROWSER_HEADERS: dict[str, str] = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8"
    ),
    "Accept-Language": "en;q=0.5",
    "DNT": "1",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}


async def _default_resolve(host: str) -> list[str]:
    loop = asyncio.get_event_loop()
    infos = await loop.getaddrinfo(host, None)
    # getaddrinfo entries: (family, type, proto, canonname, sockaddr);
    # sockaddr[0] is the IP for both IPv4 and IPv6.
    return [info[4][0] for info in infos]


async def _assert_host_is_public(host: str, resolve) -> None:
    """Resolve a hostname and reject if any address is an internal target."""
    try:
        addresses = await resolve(host)
    except Exception as error:  # noqa: BLE001 - surface as validation failure
        raise UrlValidationError(f"Could not resolve host: {host}") from error
    if not addresses:
        raise UrlValidationError(f"Could not resolve host: {host}")
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address.split("%", 1)[0])
        except ValueError:
            continue
        if _is_blocked_ip(ip):
            raise UrlValidationError(
                "Import URL must not resolve to an internal address"
            )


async def download_html(url: str, *, session, resolve=None) -> str:
    """Download a page's raw HTML after validating the URL and re-checking DNS.

    Args:
        url: The recipe URL to fetch.
        session: An aiohttp-like session exposing ``get(url, headers=...)`` as
            an async context manager with an async ``text()``.
        resolve: Optional async resolver ``host -> list[str]`` for testing;
            defaults to the event loop's getaddrinfo.

    Raises:
        UrlValidationError: invalid scheme/host, IP-literal or DNS-resolved
            internal target.
        DownloadError: non-2xx response or a network error.
    """
    validate_import_url(url)

    parsed = urlparse(url)
    host = _extract_host(parsed.netloc)

    # Only hostnames need DNS re-check; IP literals were already vetted by
    # validate_import_url.
    try:
        ipaddress.ip_address(host)
        is_ip_literal = True
    except ValueError:
        is_ip_literal = False

    if not is_ip_literal:
        await _assert_host_is_public(host, resolve or _default_resolve)

    try:
        async with session.get(url, headers=_BROWSER_HEADERS) as response:
            status = getattr(response, "status", 200)
            if status < 200 or status >= 300:
                raise DownloadError(
                    f"Download from {url} failed with HTTP status {status}"
                )
            return await response.text()
    except DownloadError:
        raise
    except Exception as error:  # noqa: BLE001 - normalize transport failures
        raise DownloadError(f"Download from {url} failed: {error}") from error


# --- Import orchestration (HA-independent) -----------------------------------

class RecipeImportError(RuntimeError):
    """Raised when a page was downloaded but no supported recipe was found."""


async def import_recipe_draft(
    url: str,
    *,
    session,
    store=None,
    recipe_id: str | None = None,
    resolve=None,
) -> dict[str, Any]:
    """Import a recipe URL into a v6 draft, ready for editor review.

    Chains the pure building blocks so the HA service is a thin wrapper:
    validate + DNS-SSRF re-check + download -> JSON-LD -> Microdata fallback ->
    normalize_to_v6. On success, and only when a store and recipe_id are given,
    the raw HTML is persisted as import.html for audit.

    Args:
        url: The recipe URL.
        session: aiohttp-like session (see download_html).
        store: Optional RecipeStore-like object exposing save_import_html.
        recipe_id: Optional id to associate the saved import.html with.
        resolve: Optional async DNS resolver for testing.

    Raises:
        UrlValidationError: invalid/blocked URL or DNS target.
        DownloadError: non-2xx response or network error.
        RecipeImportError: no JSON-LD or microdata recipe found.
    """
    html = await download_html(url, session=session, resolve=resolve)

    source = extract_jsonld_recipe(html)
    if source is None:
        source = extract_microdata_recipe(html)
    if source is None:
        raise RecipeImportError(
            "No supported recipe markup (JSON-LD or microdata) was found"
        )

    draft = normalize_to_v6(source, source_url=url)

    if store is not None and recipe_id is not None:
        await store.save_import_html(recipe_id, html)

    return draft


# --- Visible text extraction (input for the AI fallback, R11) ----------------

_NON_TEXT_TAGS: frozenset[str] = frozenset(
    {"script", "style", "noscript", "template", "svg", "head"}
)


def extract_visible_text(html: str) -> str:
    """Return the visible text of an HTML document.

    Script, style and other non-content tags are skipped. Whitespace is
    collapsed. Used to feed the AI fallback a compact, token-friendly input
    instead of raw HTML.
    """
    builder = _DomBuilder()
    builder.feed(html or "")
    parts: list[str] = []

    def walk(node: _Node) -> None:
        if node.tag in _NON_TEXT_TAGS:
            return
        parts.extend(node.text_parts)
        for child in node.children:
            walk(child)

    walk(builder.root)
    return " ".join(" ".join(parts).split())
