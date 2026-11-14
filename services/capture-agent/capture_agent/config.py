"""Load live-call settings from the environment or the repo's .env.local.

Secrets stay in .env.local (git-ignored). Nothing here prints a value; error
messages name only the missing keys.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

CHERT_KEYS = ("CHERT_API_KEY", "CHERT_PROJECT_ID", "CHERT_LINE_ID", "CHERT_TEST_DESTINATION")
LIVEKIT_KEYS = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")


def load_env_file(path: Path = REPO_ROOT / ".env.local") -> None:
    """Minimal KEY=VALUE reader; existing environment variables win."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.split(" #", 1)[0].strip().strip('"').strip("'")
        if key.strip() and value:
            os.environ.setdefault(key.strip(), value)


@dataclass(frozen=True)
class LiveConfig:
    chert_api_key: str
    chert_project_id: str
    chert_line_id: str
    destination: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    chert_base_url: str = "https://facetime.trychert.com/api/v1"

    @property
    def destination_type(self) -> str:
        return "email" if "@" in self.destination else "phone"


def missing(keys: tuple[str, ...]) -> list[str]:
    return [k for k in keys if not os.environ.get(k)]


def livekit_only() -> tuple[str, str, str]:
    load_env_file()
    absent = missing(LIVEKIT_KEYS)
    if absent:
        raise SystemExit(f"missing in .env.local: {', '.join(absent)}")
    return os.environ["LIVEKIT_URL"], os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"]


def load() -> LiveConfig:
    load_env_file()
    absent = missing(CHERT_KEYS + LIVEKIT_KEYS)
    if absent:
        raise SystemExit(f"missing in .env.local: {', '.join(absent)}")
    e = os.environ
    return LiveConfig(
        chert_api_key=e["CHERT_API_KEY"],
        chert_project_id=e["CHERT_PROJECT_ID"],
        chert_line_id=e["CHERT_LINE_ID"],
        destination=e["CHERT_TEST_DESTINATION"],
        livekit_url=e["LIVEKIT_URL"],
        livekit_api_key=e["LIVEKIT_API_KEY"],
        livekit_api_secret=e["LIVEKIT_API_SECRET"],
        chert_base_url=e.get("CHERT_BASE_URL", "https://facetime.trychert.com/api/v1"),
    )
