import type { Metadata } from "next";
import Link from "next/link";
import { NewFixtureProject } from "./new-fixture-project";

export const metadata: Metadata = { title: "New fixture project" };

export default function NewProjectPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <Link href="/projects" className="text-sm text-muted underline hover:text-accent">
        ← My projects
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">New fixture project</h1>
      <p className="mt-2 leading-relaxed text-muted">
        Creates a project whose original take starts empty (revision 1), uploads the labeled axis-box GLB straight to
        private storage with a signed URL, records its metadata, then saves revision 2 with the box in the scene. The
        API only ever receives JSON metadata.
      </p>
      <NewFixtureProject />
    </main>
  );
}
