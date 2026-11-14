---
name: "kickoff-project"
description: "Establish project planning records in an existing starter with an initialized toolkit; do not scaffold an application."
---

<!-- hackathon-toolkit-adapter:v1 sha256=92b706529b39178d4867b47eaa1322be6b1640a899e7fbb8cf42de99af249d1f -->

# kickoff-project

Read and follow the [Canonical workflow](../../../toolkit/.agents/skills/kickoff-project/SKILL.md) before acting.

Keep this checkout (three directories above this file) as the project root for project files, commands, and Git operations. Resolve links inside the canonical workflow relative to that workflow's file in the toolkit. Follow the toolkit's PROJECT_CONTRACT.md and FORMATS.md, along with this project's AGENTS.md and approved records.

If the canonical file is missing, initialize the pinned submodule from the project root with `git submodule update --init --recursive`, then read it. Shared project tools are listed in AGENTS.md and package.json; run them from the project root.
