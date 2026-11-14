import { MemoryBackend } from "@/lib/reference/memory-backend";
import { describeBackendConformance } from "./backend-conformance";

describeBackendConformance("MemoryBackend", () => {
  const clock = new Date("2026-11-14T19:00:00.000Z");
  return {
    backend: new MemoryBackend({ now: () => clock }),
    owner: { userId: "user_owner" },
    other: { userId: "user_other" },
    now: () => clock,
  };
});
