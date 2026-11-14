import Link from "next/link";
import { GOLDEN_FIXTURES, INVALID_FIXTURES, type FixtureEntry } from "@/fixtures";
import { CONTRACTS, parseContract, type ValidationIssue } from "@/lib/contracts";
import { LANE_LABS } from "./lanes";

export const metadata = { title: "Verification lab" };

function check(entry: FixtureEntry): { pass: boolean; observed: string } {
  const result = parseContract(CONTRACTS[entry.contract].schema, entry.document);
  if (!entry.expect) {
    if (result.ok) return { pass: true, observed: "valid" };
    const first = (result.error.details?.issues as ValidationIssue[])[0];
    return { pass: false, observed: `${first.path}: ${first.message}` };
  }
  if (result.ok) return { pass: false, observed: "unexpectedly valid" };
  const issues = result.error.details?.issues as ValidationIssue[];
  const hit = issues.find(
    (i) => i.path === entry.expect!.path && i.message.includes(entry.expect!.messageIncludes),
  );
  return hit
    ? { pass: true, observed: `rejected at ${hit.path}` }
    : { pass: false, observed: `rejected elsewhere: ${issues[0].path}: ${issues[0].message}` };
}

export default function LabPage() {
  const rows = [...GOLDEN_FIXTURES, ...INVALID_FIXTURES].map((entry) => ({ entry, ...check(entry) }));
  const failures = rows.filter((r) => !r.pass).length;

  return (
    <main className="mx-auto max-w-5xl space-y-10 px-5 py-8">
      <section>
        <h1 className="text-2xl font-semibold">Verification lab</h1>
        <p className="mt-2 max-w-3xl text-muted">
          A place to check each lane&apos;s work by hand. Automated gates run with{" "}
          <code className="font-mono text-ink">npm run verify</code>; this page shows the same shared
          contracts and fixtures, plus tools to validate your own files.
        </p>
      </section>

      <section aria-labelledby="tools">
        <h2 id="tools" className="text-lg font-semibold">
          Tools
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Link href="/lab/validate" className="rounded-lg border border-line bg-panel p-4 hover:border-accent">
            <div className="font-medium">Contract validator</div>
            <p className="mt-1 text-sm text-muted">
              Paste or drop JSON (an export, a capture-agent payload, a saved manifest) and check it
              against any contract.
            </p>
          </Link>
          <Link href="/lab/glb" className="rounded-lg border border-line bg-panel p-4 hover:border-accent">
            <div className="font-medium">GLB inspector</div>
            <p className="mt-1 text-sm text-muted">
              Load the axis-box fixture or any .glb: dimensions, triangles, warnings, and a 3D view on a
              1&nbsp;m grid.
            </p>
          </Link>
        </div>
      </section>

      <section aria-labelledby="lanes">
        <h2 id="lanes" className="text-lg font-semibold">
          Lane labs
        </h2>
        <p className="mt-1 text-sm text-muted">
          Each lane owns its lab page and replaces the placeholder with a working demo of its acceptance
          check.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {LANE_LABS.map((lane) => (
            <Link
              key={lane.href}
              href={lane.href}
              className="rounded-lg border border-line bg-panel p-4 hover:border-accent"
            >
              <div className="font-medium">{lane.title}</div>
              <div className="mt-1 font-mono text-xs text-muted">
                {lane.task} · {lane.branch}
              </div>
              <p className="mt-2 text-sm text-muted">{lane.check}</p>
            </Link>
          ))}
        </div>
      </section>

      <section aria-labelledby="fixtures">
        <h2 id="fixtures" className="text-lg font-semibold">
          Contract fixtures{" "}
          <span className={failures ? "text-bad" : "text-ok"}>
            {failures ? `✗ ${failures} failing` : `✓ all ${rows.length} behave as expected`}
          </span>
        </h2>
        <p className="mt-1 text-sm text-muted">
          Validated on the server with the same schemas every lane imports from{" "}
          <code className="font-mono">lib/contracts</code>. Invalid cases must be rejected at the listed
          path.
        </p>
        <div className="mt-3 overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-panel-2 text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Fixture</th>
                <th className="px-3 py-2 font-medium">Contract</th>
                <th className="px-3 py-2 font-medium">Expected</th>
                <th className="px-3 py-2 font-medium">Observed</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, pass, observed }) => (
                <tr key={entry.file} className="border-t border-line">
                  <td className="px-3 py-2 font-mono text-xs">{entry.file}</td>
                  <td className="px-3 py-2">
                    {entry.contract}{" "}
                    <span className="text-xs text-muted">{CONTRACTS[entry.contract].contract}</span>
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {entry.expect ? `invalid at ${entry.expect.path}` : "valid"}
                  </td>
                  <td className="px-3 py-2 text-muted">{observed}</td>
                  <td className={`px-3 py-2 font-medium ${pass ? "text-ok" : "text-bad"}`}>
                    {pass ? "✓ pass" : "✗ fail"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
