"""Tests for splitting a free-form ingredient string into {name, amount, unit, note}.

schema.org recipeIngredient entries are single strings like "300 g Putenfleisch".
The v6 model stores amount, unit and name separately, so the importer must split
them. A leading quantity (number, decimal, fraction or range) becomes amount; a
following recognised cooking unit becomes unit; the rest is the name; a trailing
or embedded (...) group becomes note.

Run with:
    python3 -m pytest integration/custom_components/cookbook/test_ingredient_parse.py
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_MODULE_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook" / "url_import.py"
_spec = importlib.util.spec_from_file_location("cookbook_url_import", _MODULE_PATH)
assert _spec and _spec.loader
url_import = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(url_import)

parse_ingredient = url_import.parse_ingredient


def _p(text):
    return parse_ingredient(text)


class TestAmountUnitName:
    def test_amount_unit_name(self) -> None:
        assert _p("300 g Putenfleisch") == {
            "name": "Putenfleisch", "amount": "300", "unit": "g", "note": "",
        }

    def test_amount_no_unit(self) -> None:
        # "Zwiebel" is not a unit -> amount only, rest is name.
        assert _p("1  Zwiebel in Ringen") == {
            "name": "Zwiebel in Ringen", "amount": "1", "unit": "", "note": "",
        }

    def test_unit_zehen(self) -> None:
        assert _p("2 Zehen Knoblauch") == {
            "name": "Knoblauch", "amount": "2", "unit": "Zehen", "note": "",
        }

    def test_decimal_amount_tl(self) -> None:
        assert _p("0.5 TL frische Zitronenmelisse") == {
            "name": "frische Zitronenmelisse", "amount": "0.5", "unit": "TL", "note": "",
        }

    def test_unit_zweig(self) -> None:
        assert _p("1 Zweig Rosmarin") == {
            "name": "Rosmarin", "amount": "1", "unit": "Zweig", "note": "",
        }

    def test_el_unit(self) -> None:
        assert _p("2 EL Öl") == {
            "name": "Öl", "amount": "2", "unit": "EL", "note": "",
        }

    def test_amount_no_unit_plural_name(self) -> None:
        assert _p("10  Basilikumblätter") == {
            "name": "Basilikumblätter", "amount": "10", "unit": "", "note": "",
        }


class TestQuantityForms:
    def test_fraction(self) -> None:
        assert _p("1/2 TL Salz") == {
            "name": "Salz", "amount": "1/2", "unit": "TL", "note": "",
        }

    def test_range(self) -> None:
        assert _p("2-3 EL Zucker") == {
            "name": "Zucker", "amount": "2-3", "unit": "EL", "note": "",
        }

    def test_comma_decimal(self) -> None:
        assert _p("1,5 kg Kartoffeln") == {
            "name": "Kartoffeln", "amount": "1,5", "unit": "kg", "note": "",
        }


class TestNoAmount:
    def test_name_only(self) -> None:
        assert _p("Salz") == {"name": "Salz", "amount": "", "unit": "", "note": ""}

    def test_name_only_multiword(self) -> None:
        assert _p("frisch gemahlener Pfeffer") == {
            "name": "frisch gemahlener Pfeffer", "amount": "", "unit": "", "note": "",
        }

    def test_empty(self) -> None:
        assert _p("") == {"name": "", "amount": "", "unit": "", "note": ""}


class TestNote:
    def test_trailing_parenthesis_note(self) -> None:
        assert _p("200 g Sahne (mind. 30% Fett)") == {
            "name": "Sahne", "amount": "200", "unit": "g", "note": "mind. 30% Fett",
        }

    def test_note_without_amount(self) -> None:
        assert _p("Öl (zum Braten)") == {
            "name": "Öl", "amount": "", "unit": "", "note": "zum Braten",
        }
