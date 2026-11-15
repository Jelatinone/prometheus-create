/** Existing Python FaceTime adapter plus live authenticated HTTP outbox relay.
 * Required env: INGEST_API_URL, INGEST_ACCESS_TOKEN, CAPTURE_PYTHON (absolute, or relative to the repo root).
 * tsx lib/capture/call-http.mts --project prj_... --seconds 35 [--prompt "chair" [--max-spend 0.10]]
 * With --prompt, the live loop (live-loop-cli.mts, HK-011 CP-022) also segments fresh frames during the
 * call and starts at most one reconstruction before hang-up. Those are paid provider calls.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

if (!process.env.INGEST_API_URL || !process.env.INGEST_ACCESS_TOKEN) throw new Error("INGEST_API_URL and INGEST_ACCESS_TOKEN are required");
const root = resolve(import.meta.dirname, "../..");
const configured = process.env.CAPTURE_PYTHON;
if (!configured) throw new Error("CAPTURE_PYTHON must point to the existing capture-agent Python environment");
const python = isAbsolute(configured) || !/[\\/]/.test(configured) ? configured : resolve(root, configured);
const agentRoot = resolve(root, "services/capture-agent");
const outboxRoot = resolve(agentRoot, "outbox");

// Live-loop options are ours; everything else goes to the agent unchanged.
const args = process.argv.slice(2);
const take = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const prompt = take("--prompt");
const maxSpend = take("--max-spend");
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};

const before = new Set(existsSync(outboxRoot) ? readdirSync(outboxRoot) : []);
let done = false; let callCode = 0;
const child = spawn(python, ["-u", "-m", "capture_agent.live", "call", ...args], { cwd: agentRoot, env: process.env, stdio: "inherit" });
child.on("error", e => { console.error(e.message); done = true; callCode = 1; });
child.on("exit", code => { done = true; callCode = code ?? 1; });
const exited = (proc: ReturnType<typeof spawn>) => new Promise<number>(resolveExit => {
  proc.on("error", e => { console.error(e.message); resolveExit(1); });
  proc.on("exit", code => resolveExit(code ?? 1));
});
let relayDone: Promise<number> | undefined;
let loopDone: Promise<number> | undefined;
const deadline = Date.now() + 180_000;
while (!done && Date.now() < deadline) {
  if (!relayDone && existsSync(outboxRoot)) {
    const dirs = readdirSync(outboxRoot).filter(d => !before.has(d));
    for (const d of dirs) {
      const dir = resolve(outboxRoot, d);
      const registration = resolve(dir, "source-registration.json");
      if (!existsSync(registration)) continue;
      const source = JSON.parse(readFileSync(registration, "utf8"));
      const project = option("--project");
      if (project && source.projectId !== project) continue;
      const relay = spawn(process.execPath, ["--import", "tsx", "lib/capture/replay-http.mts", dir, "--watch-seconds", "150"], { cwd: root, env: process.env, stdio: "inherit" });
      relayDone = exited(relay);
      if (prompt) {
        const loopArgs = ["--import", "tsx", "lib/capture/live-loop-cli.mts", dir, "--prompt", prompt, "--seconds", option("--seconds") ?? "60"];
        if (maxSpend) loopArgs.push("--max-spend", maxSpend);
        loopDone = exited(spawn(process.execPath, loopArgs, { cwd: root, env: process.env, stdio: "inherit" }));
      }
      break;
    }
  }
  await new Promise(r => setTimeout(r, 200));
}
if (!done) { child.kill(); callCode = 1; }
const relayCode = relayDone ? await relayDone : 1;
const loopCode = loopDone ? await loopDone : 0;
process.exitCode = callCode || relayCode || loopCode;
