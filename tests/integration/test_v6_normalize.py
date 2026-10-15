"""Tests for schema.org -> v6 recipe normalization (feature-07).

schema.org exposes ingredients (``recipeIngredient``) and steps
(``recipeInstructions``) as separate lists with no per-step mapping. The v6
model stores structured steps of ``{ingredients, instruction}``. Since the
source provides no mapping, all ingredients are attached to the first step and
the user re-groups them in the editor review. This mirrors the documented v6
migration behavior for single-step recipes.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_v6_normalize.py
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "url_import.py"
_spec = importlib.util.spec_from_file_location("cookbook_url_import", _MODULE_PATH)
assert _spec and _spec.loader
url_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_import)

normalize_to_v6 = url_import.normalize_to_v6


SOURCE_URL = "https://example.com/pancakes"


class TestNormalizeCore:
    def test_maps_name_and_description(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "Pancakes", "description": "Fluffy"},
            source_url=SOURCE_URL,
        )
        assert recipe["name"] == "Pancakes"
        assert recipe["description"] == "Fluffy"

    def test_sets_source_url_and_schema_markers(self) -> None:
        recipe = normalize_to_v6({"@type": "Recipe", "name": "X"}, source_url=SOURCE_URL)
        assert recipe["url"] == SOURCE_URL
        assert recipe["@type"] == "Recipe"
        assert recipe["@context"] == "http://schema.org"
        assert recipe["_cookbook_schema_version"] == 6

    def test_missing_optional_fields_use_valid_defaults(self) -> None:
        recipe = normalize_to_v6({"@type": "Recipe", "name": "X"}, source_url=SOURCE_URL)
        assert recipe["description"] == ""
        assert recipe["recipeCategory"] == ""
        assert recipe["keywords"] == ""
        assert recipe["recipeYield"] is None
        assert recipe["image"] == ""
        assert recipe["recipeInstructions"] == []
        assert recipe["prepTime"] is None
        assert recipe["cookTime"] is None
        assert recipe["totalTime"] is None


class TestNormalizeKeywords:
    def test_list_keywords_become_comma_string(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "keywords": ["Thai", "Salat"]},
            source_url=SOURCE_URL,
        )
        assert recipe["keywords"] == "Thai,Salat"

    def test_string_keywords_pass_through(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "keywords": "Thai,Salat"},
            source_url=SOURCE_URL,
        )
        assert recipe["keywords"] == "Thai,Salat"


class TestNormalizeCategory:
    def test_list_category_uses_first(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "recipeCategory": ["Salat", "Vorspeise"]},
            source_url=SOURCE_URL,
        )
        assert recipe["recipeCategory"] == "Salat"


class TestNormalizeYield:
    def test_numeric_string_yield(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "recipeYield": "4"},
            source_url=SOURCE_URL,
        )
        assert recipe["recipeYield"] == 4

    def test_yield_with_text(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "recipeYield": "4 servings"},
            source_url=SOURCE_URL,
        )
        assert recipe["recipeYield"] == 4

    def test_unparseable_yield_is_null(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "recipeYield": "a lot"},
            source_url=SOURCE_URL,
        )
        assert recipe["recipeYield"] is None


class TestNormalizeImage:
    def test_string_image(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "image": "https://img/x.jpg"},
            source_url=SOURCE_URL,
        )
        assert recipe["image"] == "https://img/x.jpg"

    def test_list_image_uses_first(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "image": ["https://img/a.jpg", "https://img/b.jpg"]},
            source_url=SOURCE_URL,
        )
        assert recipe["image"] == "https://img/a.jpg"

    def test_image_object_with_url(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "image": {"@type": "ImageObject", "url": "https://img/c.jpg"}},
            source_url=SOURCE_URL,
        )
        assert recipe["image"] == "https://img/c.jpg"


class TestNormalizeInstructions:
    def test_string_instructions_single_step(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["100 g flour", "2 eggs"],
                "recipeInstructions": "Mix and cook.",
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert len(steps) == 1
        assert steps[0]["instruction"] == "Mix and cook."

    def test_array_of_strings_becomes_steps(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeInstructions": ["Step one.", "Step two."],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert [s["instruction"] for s in steps] == ["Step one.", "Step two."]

    def test_howtostep_objects_use_text(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeInstructions": [
                    {"@type": "HowToStep", "text": "Do A."},
                    {"@type": "HowToStep", "text": "Do B."},
                ],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert [s["instruction"] for s in steps] == ["Do A.", "Do B."]

    def test_unmentioned_ingredients_fall_back_to_first_step(self) -> None:
        # Neither ingredient name appears in the generic step texts, so the
        # heuristic keeps them in the first step (nothing is lost).
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["100 g flour", "2 eggs"],
                "recipeInstructions": ["Step one.", "Step two."],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        # Ingredient strings are split into amount/unit/name.
        assert [i["name"] for i in steps[0]["ingredients"]] == ["flour", "eggs"]
        assert steps[0]["ingredients"][0]["amount"] == "100"
        assert steps[0]["ingredients"][0]["unit"] == "g"
        assert steps[1]["ingredients"] == []

    def test_ingredients_without_steps_create_one_step(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["100 g flour"],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert len(steps) == 1
        assert steps[0]["instruction"] == ""
        assert [i["name"] for i in steps[0]["ingredients"]] == ["flour"]
        assert steps[0]["ingredients"][0]["amount"] == "100"
        assert steps[0]["ingredients"][0]["unit"] == "g"

    def test_ingredient_shape_has_four_string_fields(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["100 g flour"],
                "recipeInstructions": ["Mix."],
            },
            source_url=SOURCE_URL,
        )
        ingredient = recipe["recipeInstructions"][0]["ingredients"][0]
        assert set(ingredient.keys()) == {"name", "amount", "unit", "note"}
        assert all(isinstance(v, str) for v in ingredient.values())


class TestIngredientToStepHeuristic:
    """R4a: attach each ingredient to the first step whose instruction text
    mentions its name ("newly introduced" semantics). Ingredients with no text
    match stay in the first step; no ingredient is lost or duplicated."""

    def test_ingredient_goes_to_first_mentioning_step(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["250 g Mehl", "100 g Zucker", "2 Eier"],
                "recipeInstructions": [
                    "Mehl und Zucker mischen.",
                    "Eier unterrühren.",
                ],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert [i["name"] for i in steps[0]["ingredients"]] == ["Mehl", "Zucker"]
        assert [i["name"] for i in steps[1]["ingredients"]] == ["Eier"]

    def test_ingredient_attached_only_to_first_mentioning_step(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["Butter"],
                "recipeInstructions": [
                    "Butter schmelzen.",
                    "Restliche Butter dazugeben.",
                ],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert [i["name"] for i in steps[0]["ingredients"]] == ["Butter"]
        assert steps[1]["ingredients"] == []

    def test_case_insensitive_match(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["Salz"],
                "recipeInstructions": ["Erst kochen.", "Mit SALZ abschmecken."],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert steps[0]["ingredients"] == []
        assert [i["name"] for i in steps[1]["ingredients"]] == ["Salz"]

    def test_unmentioned_ingredient_falls_back_to_first_step(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["Muskatnuss", "Zwiebel"],
                "recipeInstructions": [
                    "Zwiebel anbraten.",
                    "Alles verrühren.",
                ],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        # Zwiebel matches step 0; Muskatnuss is never mentioned -> first step.
        assert sorted(i["name"] for i in steps[0]["ingredients"]) == ["Muskatnuss", "Zwiebel"]
        assert steps[1]["ingredients"] == []

    def test_partition_is_complete_and_without_duplicates(self) -> None:
        source_ingredients = ["Mehl", "Zucker", "Eier", "Milch", "Salz"]
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": list(source_ingredients),
                "recipeInstructions": [
                    "Mehl und Salz mischen.",
                    "Eier und Milch dazu.",
                    "Zucker einrühren.",
                ],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assigned = [i["name"] for step in steps for i in step["ingredients"]]
        # Every source ingredient appears exactly once across all steps.
        assert sorted(assigned) == sorted(source_ingredients)
        assert len(assigned) == len(set(assigned))

    def test_word_boundary_avoids_substring_false_positive(self) -> None:
        # "Ei" must not match inside "Einfetten"; only the real mention counts.
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["Ei"],
                "recipeInstructions": [
                    "Form einfetten.",
                    "Ei verquirlen.",
                ],
            },
            source_url=SOURCE_URL,
        )
        steps = recipe["recipeInstructions"]
        assert steps[0]["ingredients"] == []
        assert [i["name"] for i in steps[1]["ingredients"]] == ["Ei"]


class TestNormalizeDates:
    def test_sets_created_and_modified_to_import_time(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X"},
            source_url=SOURCE_URL,
            now="2026-08-27T21:00:00+00:00",
        )
        assert recipe["dateCreated"] == "2026-08-27T21:00:00+00:00"
        assert recipe["dateModified"] == "2026-08-27T21:00:00+00:00"

    def test_date_published_taken_from_source(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "datePublished": "2020-01-15"},
            source_url=SOURCE_URL,
            now="2026-08-27T21:00:00+00:00",
        )
        assert recipe["datePublished"] == "2020-01-15"

    def test_date_published_null_when_absent(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X"},
            source_url=SOURCE_URL,
            now="2026-08-27T21:00:00+00:00",
        )
        assert recipe["datePublished"] is None

    def test_now_defaults_to_current_utc_iso(self) -> None:
        recipe = normalize_to_v6({"@type": "Recipe", "name": "X"}, source_url=SOURCE_URL)
        # Without an explicit now, an ISO-8601 timestamp is generated.
        assert isinstance(recipe["dateCreated"], str)
        assert "T" in recipe["dateCreated"]
        assert recipe["dateCreated"] == recipe["dateModified"]


class TestNormalizeAuthor:
    def test_author_object_preserved_verbatim(self) -> None:
        author = {"@type": "Person", "name": "Bianca Zapatka", "url": "https://x.test"}
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "author": author},
            source_url=SOURCE_URL,
        )
        assert recipe["author"] == author

    def test_author_string_preserved(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "author": "EAT SMARTER"},
            source_url=SOURCE_URL,
        )
        assert recipe["author"] == "EAT SMARTER"

    def test_author_list_preserved(self) -> None:
        authors = [{"@type": "Person", "name": "A"}, {"@type": "Person", "name": "B"}]
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "author": authors},
            source_url=SOURCE_URL,
        )
        assert recipe["author"] == authors

    def test_author_absent_key_not_added(self) -> None:
        recipe = normalize_to_v6({"@type": "Recipe", "name": "X"}, source_url=SOURCE_URL)
        assert "author" not in recipe


class TestKeywordsFromCategoryFallback:
    def test_keywords_used_when_present(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "keywords": ["Thai", "Salat"],
             "recipeCategory": ["Hauptgang", "Schnell"]},
            source_url=SOURCE_URL,
        )
        # keywords present -> tags from keywords; category = first category
        assert recipe["keywords"] == "Thai,Salat"
        assert recipe["recipeCategory"] == "Hauptgang"

    def test_remaining_categories_become_keywords_when_no_keywords(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X",
             "recipeCategory": ["Hauptgang", "Hausmannskost", "One Pot"]},
            source_url=SOURCE_URL,
        )
        # No keywords -> first category stays category, rest become tags.
        assert recipe["recipeCategory"] == "Hauptgang"
        assert recipe["keywords"] == "Hausmannskost,One Pot"

    def test_single_category_no_keywords_leaves_tags_empty(self) -> None:
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "recipeCategory": "Salat"},
            source_url=SOURCE_URL,
        )
        assert recipe["recipeCategory"] == "Salat"
        assert recipe["keywords"] == ""

    def test_no_category_no_keywords(self) -> None:
        recipe = normalize_to_v6({"@type": "Recipe", "name": "X"}, source_url=SOURCE_URL)
        assert recipe["recipeCategory"] == ""
        assert recipe["keywords"] == ""


class TestIngredientGroupHeaders:
    """Recipe sites embed group headers like "Für den Belag:" as plain
    recipeIngredient entries (schema.org has no ingredient groups). These are
    labels, not ingredients, and must be dropped."""

    def test_drops_colon_terminated_header_without_amount(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": ["5 Stück Ei", "Für den Belag:", "150 g Frischkäse"],
                "recipeInstructions": ["Alles zusammen."],
            },
            source_url=SOURCE_URL,
        )
        names = [i["name"] for s in recipe["recipeInstructions"] for i in s["ingredients"]]
        assert "Für den Belag" not in names
        assert "Für den Belag:" not in names
        assert "Ei" in names
        assert "Frischkäse" in names

    def test_keeps_real_ingredient_without_amount(self) -> None:
        # "Salz" has no amount and no trailing colon -> a real ingredient.
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "recipeIngredient": ["Salz", "Pfeffer"]},
            source_url=SOURCE_URL,
        )
        names = [i["name"] for s in recipe["recipeInstructions"] for i in s["ingredients"]]
        assert names == ["Salz", "Pfeffer"]

    def test_drops_multiple_headers(self) -> None:
        recipe = normalize_to_v6(
            {
                "@type": "Recipe",
                "name": "X",
                "recipeIngredient": [
                    "Für den Teig:", "500 g Mehl",
                    "Für die Füllung:", "200 g Käse",
                ],
            },
            source_url=SOURCE_URL,
        )
        names = [i["name"] for s in recipe["recipeInstructions"] for i in s["ingredients"]]
        assert names == ["Mehl", "Käse"]

    def test_keeps_ingredient_with_amount_even_if_colon(self) -> None:
        # A quantity present -> treat as ingredient regardless of a colon.
        recipe = normalize_to_v6(
            {"@type": "Recipe", "name": "X", "recipeIngredient": ["2 EL Öl: extra"]},
            source_url=SOURCE_URL,
        )
        names = [i["name"] for s in recipe["recipeInstructions"] for i in s["ingredients"]]
        assert len(names) == 1
