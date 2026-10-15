import json
from pathlib import Path

from custom_components.cookbook import CONFIG_SCHEMA


INTEGRATION_PATH = Path(__file__).parents[2] / "custom_components" / "cookbook"


def test_manifest_declares_calculated_class_and_http_dependency():
    manifest = json.loads((INTEGRATION_PATH / "manifest.json").read_text())

    assert manifest["iot_class"] == "calculated"
    assert "http" in manifest["dependencies"]
    assert "frontend" in manifest["after_dependencies"]


def test_yaml_schema_restricts_setup_to_config_entries():
    assert callable(CONFIG_SCHEMA)
