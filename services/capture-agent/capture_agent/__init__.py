"""Prometheus::create capture agent (HK-002).

Turns caller-camera frames from a Chert FaceTime call (delivered through a
LiveKit room) into the same CT-002 records every other capture adapter emits:
one SourceRegistration per call and one IngestEnvelope per selected frame,
validated against lib/contracts/json-schema before they leave the agent.
"""

__all__ = ["contracts", "frames", "envelope", "sequencer", "outbox"]
