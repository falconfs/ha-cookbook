"""Tests for JSON-LD Recipe extraction (feature-07, native import path).

Describes the parser behavior before implementation. Mirrors the upstream
Nextcloud Cookbook v0.11.9 order and shapes: a direct Recipe object, an array
of objects, and an ``@graph`` container. When multiple recipes are present the
first one wins. Pages without a Recipe yield ``None``.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_jsonld_parser.py
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

# Load the pure module directly by path so the test never pulls in the HA
# package __init__ (which imports homeassistant).
_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "url_import.py"
_spec = importlib.util.spec_from_file_location("cookbook_url_import", _MODULE_PATH)
assert _spec and _spec.loader
url_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_import)

extract_jsonld_recipe = url_import.extract_jsonld_recipe


def _html_with_jsonld(payload: str) -> str:
    return (
        "<html><head><title>x</title>"
        f'<script type="application/ld+json">{payload}</script>'
        "</head><body></body></html>"
    )


class TestExtractJsonLdRecipe:
    def test_direct_recipe_object(self) -> None:
        html = _html_with_jsonld('{"@type": "Recipe", "name": "Pancakes"}')
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "Pancakes"

    def test_type_can_be_a_list(self) -> None:
        html = _html_with_jsonld(
            '{"@type": ["Thing", "Recipe"], "name": "Soup"}'
        )
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "Soup"

    def test_array_of_objects_picks_recipe(self) -> None:
        html = _html_with_jsonld(
            '[{"@type": "WebSite", "name": "Blog"},'
            ' {"@type": "Recipe", "name": "Curry"}]'
        )
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "Curry"

    def test_graph_container(self) -> None:
        html = _html_with_jsonld(
            '{"@context": "https://schema.org",'
            ' "@graph": [{"@type": "Organization", "name": "Org"},'
            ' {"@type": "Recipe", "name": "Bread"}]}'
        )
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "Bread"

    def test_first_recipe_wins_when_multiple(self) -> None:
        html = _html_with_jsonld(
            '[{"@type": "Recipe", "name": "First"},'
            ' {"@type": "Recipe", "name": "Second"}]'
        )
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "First"

    def test_multiple_script_blocks_first_recipe_wins(self) -> None:
        html = (
            "<html><head>"
            '<script type="application/ld+json">'
            '{"@type": "WebSite", "name": "Blog"}</script>'
            '<script type="application/ld+json">'
            '{"@type": "Recipe", "name": "Stew"}</script>'
            "</head><body></body></html>"
        )
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "Stew"

    def test_no_recipe_returns_none(self) -> None:
        html = _html_with_jsonld('{"@type": "WebSite", "name": "Blog"}')
        assert extract_jsonld_recipe(html) is None

    def test_no_jsonld_returns_none(self) -> None:
        html = "<html><head><title>x</title></head><body></body></html>"
        assert extract_jsonld_recipe(html) is None

    def test_malformed_json_is_ignored(self) -> None:
        html = _html_with_jsonld('{"@type": "Recipe", "name": broken}')
        assert extract_jsonld_recipe(html) is None

    def test_malformed_block_does_not_hide_valid_block(self) -> None:
        html = (
            "<html><head>"
            '<script type="application/ld+json">{ broken json </script>'
            '<script type="application/ld+json">'
            '{"@type": "Recipe", "name": "Valid"}</script>'
            "</head><body></body></html>"
        )
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "Valid"


class TestGraphAsObject:
    """Some sites (e.g. Yoast/WordPress) emit @graph as an object keyed by
    numeric strings ({"0": {...}, "7": {...}}) instead of a JSON array."""

    def test_graph_object_with_numeric_keys(self) -> None:
        html = _html_with_jsonld(
            '{"@context": "https://schema.org", "@graph": {'
            '"0": {"@type": "NewsArticle", "name": "Article"},'
            '"7": {"@type": "Recipe", "name": "Shirazi Salat"}}}'
        )
        recipe = extract_jsonld_recipe(html)
        assert recipe is not None
        assert recipe["name"] == "Shirazi Salat"


class TestWebPageMainEntity:
    def test_complete_main_entity_wins_over_metadata_only_recipe(self) -> None:
        html = (
            "<html><head>"
            '<script type="application/ld+json">'
            '{"@type":"WebPage","mainEntity":{"@type":"Recipe",'
            '"name":"Gemüse-Lasagne","recipeIngredient":["1 Zucchini"],'
            '"recipeInstructions":[{"@type":"HowToStep","text":"Würfeln."}]}}'
            "</script>"
            '<script type="application/ld+json">'
            '{"@type":"Recipe","@id":"#rating","aggregateRating":{"ratingValue":"5"}}'
            "</script></head><body></body></html>"
        )

        recipe = extract_jsonld_recipe(html)

        assert recipe is not None
        assert recipe["name"] == "Gemüse-Lasagne"
        assert recipe["recipeIngredient"] == ["1 Zucchini"]

    def test_metadata_only_recipe_is_not_selected(self) -> None:
        html = _html_with_jsonld(
            '{"@type":"Recipe","@id":"#rating",'
            '"aggregateRating":{"ratingValue":"5"}}'
        )

        assert extract_jsonld_recipe(html) is None

    def test_complete_recipe_in_later_block_wins_over_named_partial_recipe(self) -> None:
        html = (
            "<html><head>"
            '<script type="application/ld+json">'
            '{"@type":"Recipe","name":"Recipe card"}'
            "</script>"
            '<script type="application/ld+json">'
            '{"@type":"Recipe","name":"Full recipe",'
            '"recipeIngredient":["1 carrot"],'
            '"recipeInstructions":["Chop the carrot."]}'
            "</script></head><body></body></html>"
        )

        recipe = extract_jsonld_recipe(html)

        assert recipe is not None
        assert recipe["name"] == "Full recipe"
