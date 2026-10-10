"""The OR core must stay separate from the web application.

`or_models/` may import only `pulp`, the standard library and itself.  If this
fails, modelling code has started depending on the data layer or the API.
"""

from __future__ import annotations

import ast
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parents[1] / "or_models"
ALLOWED = {"pulp", "or_models", "__future__", "dataclasses", "typing"}


def test_or_models_import_only_pulp_and_the_standard_library() -> None:
    for path in sorted(MODEL_DIR.glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0:
                roots = [(node.module or "").split(".")[0]]
            else:
                continue
            for root in roots:
                assert root in ALLOWED, f"{path.name} imports {root}"


def test_model_files_stay_short() -> None:
    """Modelling code should be readable on a couple of screens."""
    for name in ("lp_model.py", "ip_model.py"):
        lines = (MODEL_DIR / name).read_text(encoding="utf-8").splitlines()
        assert len(lines) < 200, f"{name} has grown to {len(lines)} lines"
