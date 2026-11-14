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
    chert_base_url: str = "https://app.trychert.com/api/v1"

    @property
    def destination_type(self) -> str:
        return "email" if "@" in self.destination else "phone"


MASK_CHARS = "•●*"


def missing(keys: tuple[str, ...]) -> list[str]:
    return [k for k in keys if not os.environ.get(k)]


def masked(keys: tuple[str, ...]) -> list[str]:
    """Keys whose value is a dashboard's masked placeholder (e.g. "••••") instead of the secret."""
    return [k for k in keys if any(c in MASK_CHARS for c in os.environ.get(k, ""))]


def destination_problem(destination: str) -> str | None:
    """Chert destinations are E.164 phones (+15551234567) or Apple ID emails. Never guess a country code."""
    import re

    if not destination:
        return "CHERT_TEST_DESTINATION is empty"
    if "@" in destination:
        return None if re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", destination) else "CHERT_TEST_DESTINATION is not a valid email"
    if not re.fullmatch(r"\+[1-9]\d{7,14}", destination):
        return "CHERT_TEST_DESTINATION must be E.164 with the country code, e.g. +15551234567"
    return None


def require_unmasked(keys: tuple[str, ...]) -> None:
    bad = masked(keys)
    if bad:
        raise SystemExit(f"{', '.join(bad)} in .env.local holds a masked placeholder (bullet characters copied from a dashboard); paste the real value")


def livekit_only() -> tuple[str, str, str]:
    load_env_file()
    absent = missing(LIVEKIT_KEYS)
    if absent:
        raise SystemExit(f"missing in .env.local: {', '.join(absent)}")
    require_unmasked(LIVEKIT_KEYS)
    return os.environ["LIVEKIT_URL"], os.environ["LIVEKIT_API_KEY"], os.environ["LIVEKIT_API_SECRET"]


#: Chert's setup guide (app.trychert.com/skills.md): "Never send a Chert key to
#: any address other than app.trychert.com." The client refuses other hosts.
CHERT_BASE_URL = "https://app.trychert.com/api/v1"
CHERT_HOST = "app.trychert.com"


def chert_base_url() -> str:
    from urllib.parse import urlparse

    url = os.environ.get("CHERT_BASE_URL", CHERT_BASE_URL).rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != CHERT_HOST:
        raise SystemExit(f"CHERT_BASE_URL must be https://{CHERT_HOST}/…; refusing to send the Chert key elsewhere")
    return url


def load(require_line: bool = True) -> LiveConfig:
    """Live settings. `require_line=False` is for read-only checks before a line is issued."""
    load_env_file()
    needed = CHERT_KEYS + LIVEKIT_KEYS if require_line else ("CHERT_API_KEY", "CHERT_PROJECT_ID")
    absent = missing(needed)
    if absent:
        raise SystemExit(f"missing in .env.local: {', '.join(absent)}")
    require_unmasked(needed)
    e = os.environ
    if require_line and (problem := destination_problem(e.get("CHERT_TEST_DESTINATION", ""))):
        raise SystemExit(problem)
    return LiveConfig(
        chert_api_key=e["CHERT_API_KEY"],
        chert_project_id=e["CHERT_PROJECT_ID"],
        chert_line_id=e.get("CHERT_LINE_ID", ""),
        destination=e.get("CHERT_TEST_DESTINATION", ""),
        livekit_url=e.get("LIVEKIT_URL", ""),
        livekit_api_key=e.get("LIVEKIT_API_KEY", ""),
        livekit_api_secret=e.get("LIVEKIT_API_SECRET", ""),
        chert_base_url=chert_base_url(),
    )
