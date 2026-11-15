/** Existing Python FaceTime adapter plus live authenticated HTTP outbox relay.
 * Required env: INGEST_API_URL, INGEST_ACCESS_TOKEN, CAPTURE_PYTHON.
 * tsx lib/capture/call-http.mts --project prj_... --seconds 35
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (!process.env.INGEST_API_URL || !process.env.INGEST_ACCESS_TOKEN) throw new Error("INGEST_API_URL and INGEST_ACCESS_TOKEN are required");
const python = process.env.CAPTURE_PYTHON;
if (!python) throw new Error("CAPTURE_PYTHON must point to the existing capture-agent Python environment");
const root = resolve(import.meta.dirname, "../..");
const agentRoot = resolve(root, "services/capture-agent");
const outboxRoot = resolve(agentRoot, "outbox");
const before = new Set(existsSync(outboxRoot) ? readdirSync(outboxRoot) : []);
let done = false; let callCode = 0;
const child = spawn(python, ["-u", "-m", "capture_agent.live", "call", ...process.argv.slice(2)], { cwd: agentRoot, env: process.env, stdio: "inherit" });
child.on("error", e => { console.error(e.message); done = true; callCode = 1; });
child.on("exit", code => { done = true; callCode = code ?? 1; });
let relay: ReturnType<typeof spawn> | undefined;
let relayDone: Promise<number> | undefined;
const deadline = Date.now() + 180_000;
while (!done && Date.now() < deadline) {
  if (!relay && existsSync(outboxRoot)) {
    const dirs = readdirSync(outboxRoot).filter(d => !before.has(d));
    for (const d of dirs) {
      const dir = resolve(outboxRoot, d);
      const registration = resolve(dir, "source-registration.json");
      if (!existsSync(registration)) continue;
      const source = JSON.parse(readFileSync(registration, "utf8"));
      const projectIndex = process.argv.indexOf("--project");
      if (projectIndex >= 0 && source.projectId !== process.argv[projectIndex + 1]) continue;
      relay = spawn(process.execPath, ["--import", "tsx", "lib/capture/replay-http.mts", dir, "--watch-seconds", "150"], { cwd: root, env: process.env, stdio: "inherit" });
      relayDone = new Promise(resolveExit => {
        relay!.on("error", e => { console.error(e.message); resolveExit(1); });
        relay!.on("exit", code => resolveExit(code ?? 1));
      });
      break;
    }
  }
  await new Promise(r => setTimeout(r, 200));
}
if (!done) { child.kill(); callCode = 1; }
const relayCode = relayDone ? await relayDone : 1;
process.exitCode = callCode || relayCode;
