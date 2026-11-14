import Link from "next/link";
import { GlbInspector } from "@/components/lab/GlbInspector";
import { AXIS_BOX_GLB_URL } from "@/fixtures";

export const metadata = { title: "GLB inspector" };

export default function GlbPage() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <Link href="/lab" className="text-sm text-muted hover:text-ink">
        ← Lab
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">GLB inspector</h1>
      <p className="mt-2 max-w-3xl text-muted">
        The shared mesh acceptance check (<code className="font-mono text-ink">inspectGlb</code>) plus a
        raw three.js view. Use it on provider output, imports, and exported GLBs. The fixture must read
        0.400 × 0.900 × 0.200. CLI: <code className="font-mono text-ink">npm run validate -- glb file.glb</code>
      </p>
      <div className="mt-6">
        <GlbInspector fixtureUrl={AXIS_BOX_GLB_URL} />
      </div>
    </main>
  );
}
