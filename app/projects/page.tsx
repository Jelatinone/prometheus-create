import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { nextCookieJar, sessionUser } from "@/lib/server/auth";
import { getBackend } from "@/lib/server/backend";

export const metadata: Metadata = { title: "My projects" };

export default function ProjectsPage() {
  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-semibold">My projects</h1>
        <Link
          href="/projects/new"
          className="rounded bg-ink px-3 py-1.5 text-sm font-medium text-canvas hover:bg-accent"
        >
          New fixture project
        </Link>
        <form action="/auth/signout" method="post" className="ml-auto">
          <button type="submit" className="text-sm text-muted underline hover:text-accent">
            Sign out
          </button>
        </form>
      </div>
      <Suspense fallback={<p className="mt-8 text-muted">Loading your projects…</p>}>
        <ProjectList />
      </Suspense>
    </main>
  );
}

async function ProjectList() {
  // Request-time only: the session check reads the clock (token expiry) and
  // the list is live database data, so it is never runtime-prefetched.
  await connection();
  const user = await sessionUser(await nextCookieJar());
  if (!user) redirect("/login?next=/projects");
  const backend = getBackend();
  const projects = await backend.listProjects(user.actor);
  if (!projects.ok) return <p className="mt-8 text-bad">Could not load projects: {projects.error.message}</p>;

  const rows = await Promise.all(
    projects.value.map(async (project) => {
      const takes = await backend.projects.listTakes(user.actor, project.id);
      const heads = takes.ok
        ? await Promise.all(
            takes.value.map(async (take) => ({
              take,
              head: await backend.projects.getRevision(user.actor, project.id, take.takeId),
            })),
          )
        : [];
      return { project, heads };
    }),
  );

  return (
    <section className="mt-6">
      <p className="text-sm text-muted">
        Signed in as <span className="font-medium text-ink">{user.email ?? user.actor.userId}</span>. Data is read
        from TigerData on every load.
      </p>
      {rows.length === 0 ? (
        <p className="mt-8">
          No projects yet. <Link href="/projects/new" className="underline hover:text-accent">Create one from the
          labeled axis-box fixture</Link>.
        </p>
      ) : (
        <ul className="mt-6 space-y-6">
          {rows.map(({ project, heads }) => (
            <li key={project.id} className="rounded border border-line bg-panel p-4" data-project-id={project.id}>
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-lg font-semibold">{project.title}</h2>
                <code className="text-xs text-muted">{project.id}</code>
                <span className="ml-auto text-xs text-muted">updated {project.updatedAt}</span>
              </div>
              <table className="mt-3 w-full text-left text-sm">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-4 font-medium">Take</th>
                    <th className="py-1 pr-4 font-medium">Head revision</th>
                    <th className="py-1 pr-4 font-medium">Revision ID</th>
                    <th className="py-1 pr-4 font-medium">Objects</th>
                    <th className="py-1 pr-4 font-medium">Manifest hash</th>
                  </tr>
                </thead>
                <tbody>
                  {heads.map(({ take, head }) => (
                    <tr key={take.takeId} className="border-t border-line" data-take-id={take.takeId}>
                      <td className="py-1 pr-4">
                        {take.name}
                        {take.parent && <span className="ml-2 text-xs text-muted">fork</span>}
                      </td>
                      <td className="py-1 pr-4 font-mono" data-head-revision={take.headRevision}>
                        {take.headRevision}
                      </td>
                      <td className="py-1 pr-4 font-mono text-xs">{take.headRevisionId}</td>
                      <td className="py-1 pr-4">{head.ok ? head.value.manifest.scene.objects.length : "?"}</td>
                      <td className="py-1 pr-4 font-mono text-xs">
                        {head.ok ? `${head.value.manifestHash.slice(0, 19)}…` : head.error.code}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
