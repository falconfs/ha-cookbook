"""Tests for schema.org Microdata Recipe extraction (feature-07 fallback).

Mirrors the upstream Nextcloud Cookbook v0.11.9 HttpMicrodataParser behavior in
Python: find the first element with itemscope + itemtype schema.org/Recipe (in
four http/https/www variants), read itemprop values (content attribute, else
text), and fall back to <p> elements for instructions when none were found.
Pages without a Recipe itemscope yield None.

The parser returns a raw schema.org-like dict; conversion to the v6 model is
done separately by normalize_to_v6().

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_microdata_parser.py
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "url_import.py"
_spec = importlib.util.spec_from_file_location("cookbook_url_import", _MODULE_PATH)
assert _spec and _spec.loader
url_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_import)

extract_microdata_recipe = url_import.extract_microdata_recipe


class TestNoRecipe:
    def test_no_itemscope_returns_none(self) -> None:
        html = "<html><body><div>No recipe here</div></body></html>"
        assert extract_microdata_recipe(html) is None

    def test_itemscope_without_recipe_type_returns_none(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Article">'
            '<span itemprop="name">Not a recipe</span></div>'
        )
        assert extract_microdata_recipe(html) is None


class TestItemtypeVariants:
    def _recipe(self, itemtype: str) -> str:
        return (
            f'<div itemscope itemtype="{itemtype}">'
            '<h1 itemprop="name">Cake</h1></div>'
        )

    def test_https_schema_org(self) -> None:
        r = extract_microdata_recipe(self._recipe("https://schema.org/Recipe"))
        assert r is not None and r["name"] == "Cake"

    def test_http_schema_org(self) -> None:
        r = extract_microdata_recipe(self._recipe("http://schema.org/Recipe"))
        assert r is not None and r["name"] == "Cake"

    def test_https_www_schema_org(self) -> None:
        r = extract_microdata_recipe(self._recipe("https://www.schema.org/Recipe"))
        assert r is not None and r["name"] == "Cake"

    def test_http_www_schema_org(self) -> None:
        r = extract_microdata_recipe(self._recipe("http://www.schema.org/Recipe"))
        assert r is not None and r["name"] == "Cake"


class TestSimpleProperties:
    def test_name_from_text_content(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<h1 itemprop="name">  Pancakes  </h1></div>'
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["name"] == "Pancakes"

    def test_content_attribute_takes_precedence(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<meta itemprop="name" content="From Attribute">Ignored text</meta>'
            "</div>"
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["name"] == "From Attribute"

    def test_keywords_and_yield(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Soup</span>'
            '<span itemprop="keywords">warm,winter</span>'
            '<span itemprop="recipeYield">4</span></div>'
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["keywords"] == "warm,winter"
        assert r["recipeYield"] == "4"


class TestListProperties:
    def test_ingredients_collected_as_list(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Dough</span>'
            '<li itemprop="recipeIngredient">250 g flour</li>'
            '<li itemprop="recipeIngredient">2 eggs</li></div>'
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["recipeIngredient"] == ["250 g flour", "2 eggs"]

    def test_instructions_collected_as_list(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Dough</span>'
            '<li itemprop="recipeInstructions">Mix.</li>'
            '<li itemprop="recipeInstructions">Bake.</li></div>'
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["recipeInstructions"] == ["Mix.", "Bake."]

    def test_alternate_ingredient_property_name(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Dough</span>'
            '<li itemprop="ingredients">flour</li></div>'
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["recipeIngredient"] == ["flour"]


class TestInstructionFixup:
    def test_falls_back_to_paragraphs_when_no_instructions(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Dough</span>'
            '<li itemprop="recipeIngredient">flour</li>'
            "<p>First do this.</p>"
            "<p>Then do that.</p></div>"
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["recipeInstructions"] == ["First do this.", "Then do that."]

    def test_no_fixup_when_instructions_present(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Dough</span>'
            '<li itemprop="recipeInstructions">Mix.</li>'
            "<p>Some marketing paragraph.</p></div>"
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["recipeInstructions"] == ["Mix."]


class TestFirstRecipeWins:
    def test_first_recipe_itemscope_is_used(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">First</span></div>'
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Second</span></div>'
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["name"] == "First"


class TestRawShape:
    def test_returns_type_and_context_markers(self) -> None:
        html = (
            '<div itemscope itemtype="https://schema.org/Recipe">'
            '<span itemprop="name">Cake</span></div>'
        )
        r = extract_microdata_recipe(html)
        assert r is not None
        assert r["@type"] == "Recipe"
