import json
import re
from pathlib import Path


INTEGRATION_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook"


def test_home_assistant_translation_files_have_matching_service_keys():
    english = json.loads((INTEGRATION_PATH / "translations/en.json").read_text())
    german = json.loads((INTEGRATION_PATH / "translations/de.json").read_text())

    assert set(english["services"]) == set(german["services"])
    assert "user" in english["config"]["step"]
    assert "user" in german["config"]["step"]
    assert _translation_shapes(english) == _translation_shapes(german)


def test_home_assistant_service_definitions_have_translation_entries():
    en_translations = json.loads((INTEGRATION_PATH / "translations/en.json").read_text())
    service_names = {
        line.split(":", 1)[0]
        for line in (INTEGRATION_PATH / "services.yaml").read_text().splitlines()
        if line and not line.startswith(" ") and ":" in line
    }

    assert service_names == set(en_translations["services"])
    assert not re.search(r"^\s+(?:name|description):", (INTEGRATION_PATH / "services.yaml").read_text(), re.MULTILINE)


def _translation_shapes(value, prefix=""):
    shapes = {}
    for key, entry in value.items():
        path = f"{prefix}.{key}" if prefix else key
        if isinstance(entry, dict):
            shapes.update(_translation_shapes(entry, path))
        else:
            shapes[path] = tuple(sorted(set(re.findall(r"\{([\w]+)\}", entry))))
    return shapes
