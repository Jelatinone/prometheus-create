import Link from "next/link";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/brand";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="text-3xl font-semibold">{PRODUCT_NAME}</h1>
      <p className="mt-2 text-lg text-muted">{PRODUCT_TAGLINE}</p>
      <p className="mt-6 leading-relaxed">
        Turn a captured view into an editable scene, preserve the original, and export another take. Sign in to see your saves, open
        a project in the editor, fork a take, and export PNG or GLB.
      </p>
      <Link
        href="/projects"
        className="mt-6 inline-block rounded-md border border-ink bg-ink px-4 py-2 text-canvas hover:border-accent hover:bg-accent"
      >
        Open your saves
      </Link>
    </main>
  );
}
