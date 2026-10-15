"""Tests for the AI-assisted import helpers (feature-07, R4c + R10-R13).

The AI response must be strictly validated against the v6 recipe shape before it
is ever shown or saved. validate_ai_recipe returns a list of human-readable
problems (empty = valid). normalize_ai_recipe coerces a validated AI dict into a
proper v6 draft (setting dates, url, schema markers), reusing the same rules as
the native importer.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_ai_import.py
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "ai_import.py"
_spec = importlib.util.spec_from_file_location("cookbook_ai_import", _MODULE_PATH)
assert _spec and _spec.loader
ai_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ai_import)

validate_ai_recipe = ai_import.validate_ai_recipe


def _valid_recipe():
    return {
        "name": "Pfannkuchen",
        "recipeInstructions": [
            {
                "instruction": "Mehl und Milch verrühren.",
                "ingredients": [
                    {"name": "Mehl", "amount": "250", "unit": "g", "note": ""},
                ],
            }
        ],
    }


class TestValidAcceptance:
    def test_minimal_valid_recipe(self) -> None:
        assert validate_ai_recipe(_valid_recipe()) == []

    def test_step_without_ingredients_is_valid(self) -> None:
        recipe = {
            "name": "X",
            "recipeInstructions": [{"instruction": "Servieren.", "ingredients": []}],
        }
        assert validate_ai_recipe(recipe) == []


class TestRejectsShape:
    def test_not_a_dict(self) -> None:
        assert validate_ai_recipe("not a dict")
        assert validate_ai_recipe(None)
        assert validate_ai_recipe([1, 2])

    def test_missing_name(self) -> None:
        recipe = _valid_recipe()
        del recipe["name"]
        problems = validate_ai_recipe(recipe)
        assert any("name" in p.lower() for p in problems)

    def test_empty_name(self) -> None:
        recipe = _valid_recipe()
        recipe["name"] = "   "
        assert any("name" in p.lower() for p in validate_ai_recipe(recipe))

    def test_missing_instructions(self) -> None:
        recipe = _valid_recipe()
        del recipe["recipeInstructions"]
        assert any("instruction" in p.lower() for p in validate_ai_recipe(recipe))

    def test_instructions_not_a_list(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"] = "Mix."
        assert validate_ai_recipe(recipe)

    def test_empty_instructions_list(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"] = []
        assert validate_ai_recipe(recipe)

    def test_step_missing_instruction_text(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"][0] = {"ingredients": []}
        assert validate_ai_recipe(recipe)

    def test_step_instruction_not_string(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"][0]["instruction"] = 5
        assert validate_ai_recipe(recipe)

    def test_ingredients_not_a_list(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"][0]["ingredients"] = "Mehl"
        assert validate_ai_recipe(recipe)

    def test_ingredient_missing_fields(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"][0]["ingredients"] = [{"name": "Mehl"}]
        assert validate_ai_recipe(recipe)

    def test_ingredient_field_not_string(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"][0]["ingredients"] = [
            {"name": "Mehl", "amount": 250, "unit": "g", "note": ""}
        ]
        assert validate_ai_recipe(recipe)

    def test_ingredient_empty_name(self) -> None:
        recipe = _valid_recipe()
        recipe["recipeInstructions"][0]["ingredients"] = [
            {"name": "  ", "amount": "1", "unit": "g", "note": ""}
        ]
        assert validate_ai_recipe(recipe)


build_extract_prompt = ai_import.build_extract_prompt
build_regroup_prompt = ai_import.build_regroup_prompt
ai_structure_schema = ai_import.ai_structure_schema
normalize_ai_recipe = ai_import.normalize_ai_recipe


class TestStructureSchema:
    def test_structure_has_core_fields(self) -> None:
        s = ai_structure_schema()
        assert "name" in s
        assert "recipeInstructions" in s
        # Each entry must carry a selector (ai_task.generate_data requirement).
        assert "selector" in s["name"]


class TestExtractPrompt:
    def test_includes_source_text_and_url(self) -> None:
        prompt = build_extract_prompt("Roher Rezepttext hier", source_url="https://x.test/r")
        assert "Roher Rezepttext hier" in prompt
        assert "https://x.test/r" in prompt

    def test_truncates_overly_long_text(self) -> None:
        long_text = "A" * 50000
        prompt = build_extract_prompt(long_text, source_url="https://x.test", max_chars=1000)
        # The embedded source text portion must be capped.
        assert len(prompt) < 5000


class TestRegroupPrompt:
    def test_includes_ingredients_and_steps(self) -> None:
        recipe = {
            "name": "X",
            "recipeInstructions": [
                {"instruction": "Mehl mischen.", "ingredients": [
                    {"name": "Mehl", "amount": "250", "unit": "g", "note": ""},
                    {"name": "Eier", "amount": "2", "unit": "", "note": ""},
                ]},
                {"instruction": "Backen.", "ingredients": []},
            ],
        }
        prompt = build_regroup_prompt(recipe)
        assert "Mehl" in prompt and "Eier" in prompt
        assert "Mehl mischen." in prompt and "Backen." in prompt


class TestNormalizeAiRecipe:
    def test_sets_v6_markers_dates_and_url(self) -> None:
        ai = {
            "name": "Pfannkuchen",
            "recipeInstructions": [
                {"instruction": "Verrühren.", "ingredients": [
                    {"name": "Mehl", "amount": "250", "unit": "g", "note": ""}]},
            ],
        }
        v6 = normalize_ai_recipe(ai, source_url="https://x.test/r", now="2026-08-28T10:00:00+00:00")
        assert v6["name"] == "Pfannkuchen"
        assert v6["@type"] == "Recipe"
        assert v6["_cookbook_schema_version"] == 6
        assert v6["url"] == "https://x.test/r"
        assert v6["dateCreated"] == "2026-08-28T10:00:00+00:00"
        assert v6["dateModified"] == "2026-08-28T10:00:00+00:00"
        assert v6["recipeInstructions"][0]["ingredients"][0]["name"] == "Mehl"

    def test_defaults_for_missing_optional_fields(self) -> None:
        ai = {"name": "X", "recipeInstructions": [{"instruction": "A", "ingredients": []}]}
        v6 = normalize_ai_recipe(ai, source_url="", now="2026-08-28T10:00:00+00:00")
        assert v6["description"] == ""
        assert v6["recipeCategory"] == ""
        assert v6["keywords"] == ""
        assert v6["recipeYield"] is None
        assert v6["tool"] == []
        assert v6["image"] == ""

    def test_optional_fields_passed_through(self) -> None:
        ai = {
            "name": "X",
            "description": "lecker",
            "recipeCategory": "Dessert",
            "keywords": "süß,schnell",
            "recipeYield": 4,
            "recipeInstructions": [{"instruction": "A", "ingredients": []}],
        }
        v6 = normalize_ai_recipe(ai, source_url="", now="2026-08-28T10:00:00+00:00")
        assert v6["description"] == "lecker"
        assert v6["recipeCategory"] == "Dessert"
        assert v6["keywords"] == "süß,schnell"
        assert v6["recipeYield"] == 4


import asyncio

ai_import_draft = ai_import.ai_import_draft
ai_regroup_draft = ai_import.ai_regroup_draft
AiImportError = ai_import.AiImportError


def _run(coro):
    return asyncio.run(coro)


class TestAiImportDraft:
    def test_returns_v6_draft_from_valid_ai_response(self) -> None:
        async def fake_generate(instructions, structure):
            return {
                "name": "KI Pfannkuchen",
                "recipeInstructions": [
                    {"instruction": "Verrühren.", "ingredients": [
                        {"name": "Mehl", "amount": "250", "unit": "g", "note": ""}]},
                ],
            }
        draft = _run(ai_import_draft("roher text", source_url="https://x.test/r",
                                     generate=fake_generate, now="2026-08-28T10:00:00+00:00"))
        assert draft["name"] == "KI Pfannkuchen"
        assert draft["_cookbook_schema_version"] == 6
        assert draft["url"] == "https://x.test/r"
        assert draft["recipeInstructions"][0]["ingredients"][0]["name"] == "Mehl"

    def test_rejects_invalid_ai_response(self) -> None:
        async def fake_generate(instructions, structure):
            return {"name": "", "recipeInstructions": []}  # invalid
        with self._assert_raises():
            _run(ai_import_draft("t", source_url="", generate=fake_generate))

    def test_rejects_non_dict_ai_response(self) -> None:
        async def fake_generate(instructions, structure):
            return "sorry, I cannot help"
        with self._assert_raises():
            _run(ai_import_draft("t", source_url="", generate=fake_generate))

    def test_passes_prompt_and_structure_to_generate(self) -> None:
        seen = {}
        async def fake_generate(instructions, structure):
            seen["instructions"] = instructions
            seen["structure"] = structure
            return {"name": "X", "recipeInstructions": [{"instruction": "A", "ingredients": []}]}
        _run(ai_import_draft("Mein Rezepttext", source_url="https://x", generate=fake_generate))
        assert "Mein Rezepttext" in seen["instructions"]
        assert "name" in seen["structure"]

    class _Ctx:
        def __enter__(self): return self
        def __exit__(self, et, ev, tb):
            assert et is AiImportError, f"expected AiImportError, got {et}"
            return True

    def _assert_raises(self):
        return self._Ctx()


class TestAiRegroupDraft:
    def _recipe(self):
        return {
            "name": "Pfannkuchen",
            "recipeInstructions": [
                {"instruction": "Mehl und Zucker mischen.", "ingredients": [
                    {"name": "Mehl", "amount": "250", "unit": "g", "note": ""},
                    {"name": "Zucker", "amount": "100", "unit": "g", "note": ""},
                    {"name": "Eier", "amount": "2", "unit": "", "note": ""}]},
                {"instruction": "Eier unterrühren.", "ingredients": []},
            ],
        }

    def test_regroups_via_ai_and_returns_v6(self) -> None:
        async def fake_generate(instructions, structure):
            # AI moves eggs to step 2
            return {
                "name": "Pfannkuchen",
                "recipeInstructions": [
                    {"instruction": "Mehl und Zucker mischen.", "ingredients": [
                        {"name": "Mehl", "amount": "250", "unit": "g", "note": ""},
                        {"name": "Zucker", "amount": "100", "unit": "g", "note": ""}]},
                    {"instruction": "Eier unterrühren.", "ingredients": [
                        {"name": "Eier", "amount": "2", "unit": "", "note": ""}]},
                ],
            }
        draft = _run(ai_regroup_draft(self._recipe(), generate=fake_generate,
                                      now="2026-08-28T10:00:00+00:00"))
        assert [i["name"] for i in draft["recipeInstructions"][1]["ingredients"]] == ["Eier"]
        assert draft["_cookbook_schema_version"] == 6

    def test_rejects_invalid_regroup_response(self) -> None:
        async def fake_generate(instructions, structure):
            return {"name": "X", "recipeInstructions": "nope"}
        raised = False
        try:
            _run(ai_regroup_draft(self._recipe(), generate=fake_generate))
        except AiImportError:
            raised = True
        assert raised
