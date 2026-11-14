---
name: "test-build"
description: "Test an identified build or integrated revision using configured checks, live integrations and the core demo; report evidence without repairing source."
---

<!-- hackathon-toolkit-adapter:v1 sha256=2574af29372f4e6e857c666ee40535d1072d209037e2dd5c7109eb1bad974a64 -->

# test-build

Read and follow the [Canonical workflow](../../../toolkit/.agents/skills/test-build/SKILL.md) before acting.

Keep this checkout (three directories above this file) as the project root for project files, commands, and Git operations. Resolve links inside the canonical workflow relative to that workflow's file in the toolkit. Follow the toolkit's PROJECT_CONTRACT.md and FORMATS.md, along with this project's AGENTS.md and approved records.

If the canonical file is missing, initialize the pinned submodule from the project root with `git submodule update --init --recursive`, then read it. Shared project tools are listed in AGENTS.md and package.json; run them from the project root.
