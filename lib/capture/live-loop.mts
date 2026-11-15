/** Live-call generation loop for one capture-agent outbox (HK-011 CP-022).
 * INGEST_API_URL=http://localhost:3005 INGEST_ACCESS_TOKEN=<short-lived user token>
 * tsx lib/capture/live-loop.mts <outbox> --prompt "chair" --seconds 35 [--max-spend 0.10]
 * Started by call-http.mts when it is given --prompt. Paid: segmentation $0.005/mask,
 * one reconstruction $0.02, capped by --max-spend. Writes <outbox>/live-loop-result.json.
 * Tokens stay in the environment, never arguments or logs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_LIVE_LOOP } from "./live-loop";
import { runLiveLoop, type LiveObservation, type SessionState } from "./live-loop-run";

const dir = resolve(process.argv[2] ?? "");
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const prompt = arg("--prompt");
const seconds = Number(arg("--seconds") ?? "35");
const maxSpendUsd = Number(arg("--max-spend") ?? String(DEFAULT_LIVE_LOOP.maxSpendUsd));
if (!process.argv[2] || !prompt) throw new Error('usage: tsx lib/capture/live-loop.mts <outbox> --prompt "chair" [--seconds 35] [--max-spend 0.10]');
if (!(maxSpendUsd > 0 && maxSpendUsd <= 0.5)) throw new Error("--max-spend must be in (0, 0.5] USD");
const baseUrl = process.env.INGEST_API_URL;
const token = process.env.INGEST_ACCESS_TOKEN;
if (!baseUrl || !token) throw new Error("INGEST_API_URL and INGEST_ACCESS_TOKEN are required");
const url = new URL(baseUrl);
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
  throw new Error("the live loop requires HTTPS or localhost");

const registrationFile = resolve(dir, "source-registration.json");
for (let i = 0; !existsSync(registrationFile); i++) {
  if (i > 600) throw new Error("no source registration appeared in the outbox");
  await new Promise((r) => setTimeout(r, 200));
}
const registration = JSON.parse(readFileSync(registrationFile, "utf8")) as { id: string; projectId: string };
const headers = { authorization: `Bearer ${token}` };

const transport = {
  async listFrames(): Promise<LiveObservation[]> {
    const response = await fetch(new URL(`/api/reconstruction/frames?projectId=${encodeURIComponent(registration.projectId)}`, baseUrl), { headers });
    if (!response.ok) throw new Error(`frames ${response.status}`);
    return (await response.json()) as LiveObservation[];
  },
  async command(body: Record<string, unknown>) {
    const response = await fetch(new URL("/api/reconstruction", baseUrl), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  },
};
const session = (): SessionState => {
  try {
    return (JSON.parse(readFileSync(resolve(dir, "capture-session.json"), "utf8")) as { state: SessionState }).state;
  } catch {
    return null;
  }
};
const out = resolve(dir, "live-loop-result.json");
const result = await runLiveLoop({
  projectId: registration.projectId,
  sourceId: registration.id,
  prompt,
  seconds,
  config: { ...DEFAULT_LIVE_LOOP, maxSpendUsd },
  transport,
  session,
  newJobId: () => `job_${randomUUID().replaceAll("-", "")}`,
  onUpdate: (r) => writeFileSync(out, JSON.stringify(r, null, 2)),
});
let selection: unknown = null;
try {
  selection = JSON.parse(readFileSync(resolve(dir, "selection-stats.json"), "utf8"));
} catch {
  /* the agent writes it when the call ends */
}
writeFileSync(out, JSON.stringify({ ...result, agentSelection: selection }, null, 2));
const rec = result.reconstruction;
console.log(
  `live loop: ${result.segmentations.length} segmentation(s), superseded ${result.counts.superseded}, kept earlier ${result.counts.keptEarlier}; ` +
    (rec ? `reconstruction ${rec.jobId} ${rec.state} (${rec.beforeHangUp ? "started before hang-up" : "started after hang-up"})` : `no reconstruction (${result.stopReason})`) +
    `; estimated spend $${result.estimatedSpendUsd.toFixed(3)}`,
);
process.exitCode = rec && rec.state !== "succeeded" ? 1 : 0;
