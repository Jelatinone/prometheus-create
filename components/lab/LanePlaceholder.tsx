import Link from "next/link";

/** Placeholder for a lane lab page until the owning lane replaces it. */
export function LanePlaceholder(props: {
  title: string;
  task: string;
  branch: string;
  check: string;
  ownedPaths: string;
}) {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <Link href="/lab" className="text-sm text-muted hover:text-ink">
        ← Lab
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">{props.title}</h1>
      <p className="mt-1 font-mono text-xs text-muted">
        {props.task} · {props.branch}
      </p>
      <div className="mt-6 rounded-lg border border-dashed border-line bg-panel p-5">
        <p className="font-medium">Not implemented yet</p>
        <p className="mt-2 text-sm text-muted">
          This page belongs to the {props.title.toLowerCase()} lane. Replace it with a demo of the
          lane&apos;s acceptance check:
        </p>
        <p className="mt-2 text-sm">{props.check}</p>
        <p className="mt-4 text-xs text-muted">Owned paths: {props.ownedPaths} (see lanes.json)</p>
      </div>
    </main>
  );
}
