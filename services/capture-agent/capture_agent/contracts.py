"""Validate agent output against the generated contract JSON Schemas.

lib/contracts (zod) is the source of truth; `npm run contracts:schema`
exports lib/contracts/json-schema/*.schema.json for non-TypeScript consumers.
JSON Schema cannot express the zod cross-field rules, so the ones the agent can
violate are re-checked here (see check_chert_registration).
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMA_DIR = REPO_ROOT / "lib" / "contracts" / "json-schema"


@lru_cache(maxsize=None)
def validator(name: str) -> Draft202012Validator:
    path = SCHEMA_DIR / f"{name}.schema.json"
    if not path.exists():
        raise FileNotFoundError(f"no generated schema {path}; run `npm run contracts:schema`")
    schema = json.loads(path.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def _path(error_path: Any) -> str:
    out = ""
    for part in error_path:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out or "(root)"


def issues(name: str, document: Any) -> list[str]:
    """Human-readable validation issues; empty when the document is valid."""
    found = [f"{_path(e.absolute_path)}: {e.message}" for e in validator(name).iter_errors(document)]
    if name == "source-registration" and not found:
        found.extend(check_chert_registration(document))
    return sorted(found)


def check_chert_registration(reg: dict[str, Any]) -> list[str]:
    """Mirror of the zod checkSource rules relevant to a Chert source."""
    problems: list[str] = []
    if reg.get("adapter") != "chert_facetime":
        return problems
    if reg.get("media", {}).get("kind") != "live_stream":
        problems.append("media.kind: chert_facetime sources are live_stream")
    if reg.get("assetId") is not None or reg.get("contentHash") is not None:
        problems.append("assetId: live_stream sources have no stored asset; frames are observations")
    if reg.get("captureSessionId") is None:
        problems.append("captureSessionId: chert_facetime sources must reference their capture session")
    return problems


class ContractViolation(ValueError):
    def __init__(self, name: str, problems: list[str]):
        super().__init__(f"{name} failed validation: " + "; ".join(problems))
        self.name = name
        self.problems = problems


def require_valid(name: str, document: Any) -> Any:
    problems = issues(name, document)
    if problems:
        raise ContractViolation(name, problems)
    return document
