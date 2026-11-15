"""Choose which caller frames become envelopes, and number them.

- Sequence numbers are assigned only to frames actually sent, monotonic per
  source (the gateway's idempotency key is sourceId + sequence).
- sourceTimeUs is the frame's presentation time relative to the first frame.
- Evidence frames (first frame, a changed view, or a periodic anchor) are
  kept; preview frames are rate-limited and only the newest waiting preview
  survives (backpressure: old unsaved previews are dropped, never queued).
- A frame identical to the last one sent (frozen camera) is skipped.
- A preview that barely differs from the last frame sent (signature
  difference below near_duplicate_threshold) is skipped as a near-duplicate
  (HK-011 CP-022). The first frame, changed views and periodic anchors are
  never dropped this way. `stats` counts every decision by reason.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from .frames import difference

Decision = Literal["evidence", "preview", "skip"]


@dataclass
class SelectorConfig:
    #: Mean signature difference (0-255) that counts as a changed view.
    change_threshold: float = 18.0
    #: Force an evidence frame at least this often while frames flow.
    evidence_interval_us: int = 5_000_000
    #: Maximum preview rate.
    preview_interval_us: int = 500_000
    #: Previews closer than this (mean signature difference, 0-255) to the last
    #: frame sent are near-duplicates. Handheld calls measured 4-12 between
    #: consecutive sent frames; a still camera 0.3-3.
    near_duplicate_threshold: float = 3.0


@dataclass
class FrameSelector:
    config: SelectorConfig = field(default_factory=SelectorConfig)
    _last_evidence_sig: bytes | None = None
    _last_evidence_us: int | None = None
    _last_preview_us: int | None = None
    _last_hash: str | None = None
    _last_sent_sig: bytes | None = None
    stats: dict[str, int] = field(
        default_factory=lambda: {"evidence": 0, "preview": 0, "skipped_identical": 0, "skipped_near_duplicate": 0, "skipped_rate_limit": 0}
    )

    def decide(self, timestamp_us: int, sig: bytes, content_hash: str | None = None) -> tuple[Decision, str]:
        decision, why = self._decide(timestamp_us, sig, content_hash)
        if decision != "skip":
            self._last_sent_sig = sig
            self.stats[decision] += 1
        elif why.startswith("identical"):
            self.stats["skipped_identical"] += 1
        elif why.startswith("near-duplicate"):
            self.stats["skipped_near_duplicate"] += 1
        else:
            self.stats["skipped_rate_limit"] += 1
        return decision, why

    def _decide(self, timestamp_us: int, sig: bytes, content_hash: str | None) -> tuple[Decision, str]:
        if content_hash is not None and content_hash == self._last_hash:
            return "skip", "identical to the last frame sent"
        if self._last_evidence_sig is None:
            return self._evidence(timestamp_us, sig, content_hash, "first frame")
        delta = difference(sig, self._last_evidence_sig)
        if delta >= self.config.change_threshold:
            return self._evidence(timestamp_us, sig, content_hash, f"view changed (difference {delta:.1f})")
        if timestamp_us - (self._last_evidence_us or 0) >= self.config.evidence_interval_us:
            return self._evidence(timestamp_us, sig, content_hash, "periodic anchor")
        if self._last_preview_us is None or timestamp_us - self._last_preview_us >= self.config.preview_interval_us:
            if self._last_sent_sig is not None:
                near = difference(sig, self._last_sent_sig)
                if near < self.config.near_duplicate_threshold:
                    return "skip", f"near-duplicate of the last frame sent (difference {near:.1f})"
            self._last_preview_us = timestamp_us
            self._last_hash = content_hash
            return "preview", "rate-limited preview"
        return "skip", "preview rate limit"

    def _evidence(self, timestamp_us: int, sig: bytes, content_hash: str | None, why: str) -> tuple[Decision, str]:
        self._last_evidence_sig = sig
        self._last_evidence_us = timestamp_us
        self._last_preview_us = timestamp_us
        self._last_hash = content_hash
        return "evidence", why


@dataclass
class Sequencer:
    """Monotonic sequence numbers and source-relative presentation times."""

    _next: int = 0
    _origin_us: int | None = None
    _last_time_us: int = -1

    def assign(self, timestamp_us: int) -> tuple[int, int]:
        if self._origin_us is None:
            self._origin_us = timestamp_us
        # Clamp to non-decreasing time: a backwards camera clock never yields negative or reordered times.
        source_time = max(timestamp_us - self._origin_us, self._last_time_us, 0)
        self._last_time_us = source_time
        sequence = self._next
        self._next += 1
        return sequence, source_time


class LatestOnly:
    """One-slot buffer: a newer preview replaces an unsent older one."""

    def __init__(self) -> None:
        self._item = None
        self.dropped = 0

    def offer(self, item) -> None:
        if self._item is not None:
            self.dropped += 1
        self._item = item

    def take(self):
        item, self._item = self._item, None
        return item
