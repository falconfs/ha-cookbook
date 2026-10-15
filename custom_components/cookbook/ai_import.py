"""AI-assisted recipe import helpers (feature-07, R4c + R10-R13).

Pure, Home-Assistant-independent logic for the optional AI paths:

* validate_ai_recipe: strict validation of an AI response against the v6 recipe
  shape. Invalid responses are rejected before they are ever shown or saved.
* build_extract_prompt / build_regroup_prompt: prompt text + the ``structure``
  selector schema passed to ``ai_task.generate_data``.
* normalize_ai_recipe: coerce a validated AI dict into a v6 draft.

Kept free of the HA runtime so it is fully unit-testable; the HA service layer
in services.py calls ai_task.generate_data and feeds the result through here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

_INGREDIENT_FIELDS = ("name", "amount", "unit", "note")


def validate_ai_recipe(data: Any) -> list[str]:
    """Validate an AI-produced recipe against the v6 shape.

    Returns a list of human-readable problems; an empty list means valid. Only
    the fields the AI is responsible for are checked (name + structured steps);
    identity/date/schema fields are added later by normalize_ai_recipe.
    """
    problems: list[str] = []

    if not isinstance(data, dict):
        return ["AI response is not a recipe object"]

    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        problems.append("Missing or empty recipe name")

    steps = data.get("recipeInstructions")
    if not isinstance(steps, list):
        problems.append("recipeInstructions must be a list")
        return problems
    if not steps:
        problems.append("recipeInstructions must not be empty")
        return problems

    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            problems.append(f"step {index}: not an object")
            continue
        instruction = step.get("instruction")
        if not isinstance(instruction, str) or not instruction.strip():
            problems.append(f"step {index}: missing instruction text")
        ingredients = step.get("ingredients")
        if not isinstance(ingredients, list):
            problems.append(f"step {index}: ingredients must be a list")
            continue
        for j, ing in enumerate(ingredients):
            if not isinstance(ing, dict):
                problems.append(f"step {index} ingredient {j}: not an object")
                continue
            for field in _INGREDIENT_FIELDS:
                value = ing.get(field)
                if not isinstance(value, str):
                    problems.append(
                        f"step {index} ingredient {j}: '{field}' must be a string"
                    )
            name_value = ing.get("name")
            if isinstance(name_value, str) and not name_value.strip():
                problems.append(f"step {index} ingredient {j}: empty name")

    return problems


# --- Prompt building + structure schema for ai_task.generate_data -----------

# The `structure` selector schema mirrors the v6 recipe fields the AI must
# return. ai_task.generate_data converts this dict into a JSON schema for the
# model. Nested lists/objects use the object/list selectors HA supports.
def ai_structure_schema() -> dict[str, Any]:
    return {
        "name": {"selector": {"text": {}}, "required": True},
        "description": {"selector": {"text": {"multiline": True}}},
        "recipeCategory": {"selector": {"text": {}}},
        "keywords": {"selector": {"text": {}}},
        "recipeYield": {"selector": {"number": {"mode": "box"}}},
        "recipeInstructions": {
            "selector": {
                "object": {
                    "multiple": True,
                    "fields": {
                        "instruction": {"selector": {"text": {"multiline": True}}},
                        "ingredients": {
                            "selector": {
                                "object": {
                                    "multiple": True,
                                    "fields": {
                                        "name": {"selector": {"text": {}}},
                                        "amount": {"selector": {"text": {}}},
                                        "unit": {"selector": {"text": {}}},
                                        "note": {"selector": {"text": {}}},
                                    },
                                }
                            }
                        },
                    },
                }
            },
            "required": True,
        },
    }


_V6_RULES = (
    "Antworte als strukturiertes Rezept im v6-Format. Regeln:\n"
    "- name: Titel des Rezepts.\n"
    "- recipeInstructions: geordnete Liste von Schritten. Jeder Schritt hat "
    "'instruction' (Text) und 'ingredients' (Liste).\n"
    "- Jede Zutat hat genau die Felder name, amount, unit, note (alle Strings; "
    "fehlende Werte als \"\").\n"
    "- amount = reine Menge (z.B. '250', '1/2', '2-3'); unit = Einheit (z.B. "
    "'g', 'EL', 'Zehen'); name = Zutat ohne Menge/Einheit.\n"
    "- Ordne jede Zutat dem Schritt zu, in dem sie zum ersten Mal verwendet "
    "wird ('neu hinzukommend'). Jede Zutat genau einmal.\n"
    "- Erfinde keine Zutaten oder Schritte; nutze nur die Quelle."
)


def build_extract_prompt(
    source_text: str, *, source_url: str = "", max_chars: int = 12000
) -> str:
    """Prompt for extracting a v6 recipe from raw page text (R10-R13)."""
    text = (source_text or "").strip()
    if len(text) > max_chars:
        text = text[:max_chars]
    parts = [
        "Extrahiere aus dem folgenden Seiteninhalt ein Kochrezept.",
        _V6_RULES,
    ]
    if source_url:
        parts.append(f"Quelle: {source_url}")
    parts.append("--- Seiteninhalt ---")
    parts.append(text)
    return "\n\n".join(parts)


def build_regroup_prompt(recipe: dict[str, Any]) -> str:
    """Prompt for re-grouping already-extracted ingredients to steps (R4c).

    The AI must NOT invent or drop ingredients; it only reassigns the given
    ingredients to the given steps.
    """
    steps = recipe.get("recipeInstructions") or []
    all_ings: list[str] = []
    step_lines: list[str] = []
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        step_lines.append(f"{i + 1}. {step.get('instruction', '')}")
        for ing in step.get("ingredients") or []:
            if isinstance(ing, dict):
                label = " ".join(
                    v for v in (ing.get("amount"), ing.get("unit"), ing.get("name")) if v
                ).strip()
                if label:
                    all_ings.append(label)

    parts = [
        "Ordne die Zutaten den Zubereitungsschritten korrekt zu.",
        "Verwende AUSSCHLIESSLICH die unten gelisteten Zutaten unverändert - "
        "erfinde nichts, lasse nichts weg, dupliziere nichts.",
        "Ordne jede Zutat dem Schritt zu, in dem sie zum ersten Mal verwendet "
        "wird ('neu hinzukommend').",
        _V6_RULES,
        "--- Zutaten ---",
        "\n".join(f"- {x}" for x in all_ings),
        "--- Schritte ---",
        "\n".join(step_lines),
    ]
    return "\n\n".join(parts)


# --- Normalization of a validated AI recipe into a v6 draft -----------------

def _text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return str(value)
    return ""


def _yield(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = _text(value)
    num = ""
    for ch in text:
        if ch.isdigit():
            num += ch
        elif num:
            break
    return int(num) if num else None


def _ingredient(ing: dict[str, Any]) -> dict[str, str]:
    return {
        "name": _text(ing.get("name")),
        "amount": _text(ing.get("amount")),
        "unit": _text(ing.get("unit")),
        "note": _text(ing.get("note")),
    }


def _steps(raw: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for step in raw if isinstance(raw, list) else []:
        if not isinstance(step, dict):
            continue
        ings = [
            _ingredient(i)
            for i in (step.get("ingredients") or [])
            if isinstance(i, dict)
        ]
        result.append({"ingredients": ings, "instruction": _text(step.get("instruction"))})
    return result


def normalize_ai_recipe(
    data: dict[str, Any], *, source_url: str = "", now: str | None = None
) -> dict[str, Any]:
    """Coerce a validated AI recipe dict into a v6 draft for editor review."""
    timestamp = now or datetime.now(timezone.utc).isoformat()
    keywords = data.get("keywords")
    if isinstance(keywords, list):
        keywords = ",".join(_text(k) for k in keywords if _text(k))
    else:
        keywords = _text(keywords)

    return {
        "name": _text(data.get("name")),
        "description": _text(data.get("description")),
        "@context": "http://schema.org",
        "@type": "Recipe",
        "recipeCategory": _text(data.get("recipeCategory")),
        "keywords": keywords,
        "recipeYield": _yield(data.get("recipeYield")),
        "recipeInstructions": _steps(data.get("recipeInstructions")),
        "tool": [],
        "image": _text(data.get("image")),
        "url": source_url,
        "dateCreated": timestamp,
        "dateModified": timestamp,
        "datePublished": _text(data.get("datePublished")) or None,
        "prepTime": _text(data.get("prepTime")) or None,
        "cookTime": _text(data.get("cookTime")) or None,
        "totalTime": _text(data.get("totalTime")) or None,
        "_cookbook_schema_version": 6,
    }


# --- HA-independent AI orchestration ----------------------------------------

class AiImportError(RuntimeError):
    """Raised when the AI response is missing or fails v6 validation."""


async def ai_import_draft(
    source_text: str,
    *,
    source_url: str = "",
    generate,
    now: str | None = None,
    max_chars: int = 12000,
) -> dict[str, Any]:
    """Extract a v6 draft from raw page text via an injected AI call (R10-R13).

    ``generate`` is an async callable ``(instructions, structure) -> dict`` that
    wraps ai_task.generate_data. The response is strictly validated before it is
    normalized; invalid output raises AiImportError.
    """
    prompt = build_extract_prompt(source_text, source_url=source_url, max_chars=max_chars)
    structure = ai_structure_schema()
    data = await generate(prompt, structure)
    problems = validate_ai_recipe(data)
    if problems:
        raise AiImportError("; ".join(problems))
    return normalize_ai_recipe(data, source_url=source_url, now=now)


async def ai_regroup_draft(
    recipe: dict[str, Any],
    *,
    generate,
    now: str | None = None,
) -> dict[str, Any]:
    """Re-group an already-extracted recipe's ingredients to steps (R4c).

    ``generate`` is an async ``(instructions, structure) -> dict``. The response
    is validated and normalized; other recipe metadata (name, category, image,
    url, dates) is preserved from the input where the AI omits it.
    """
    prompt = build_regroup_prompt(recipe)
    structure = ai_structure_schema()
    data = await generate(prompt, structure)
    problems = validate_ai_recipe(data)
    if problems:
        raise AiImportError("; ".join(problems))
    draft = normalize_ai_recipe(
        data, source_url=str(recipe.get("url", "")), now=now
    )
    # Preserve metadata from the source recipe that the regroup prompt drops.
    for key in ("description", "recipeCategory", "keywords", "image", "tool"):
        if not draft.get(key) and recipe.get(key):
            draft[key] = recipe[key]
    if draft.get("recipeYield") is None and recipe.get("recipeYield") is not None:
        draft["recipeYield"] = recipe["recipeYield"]
    return draft
