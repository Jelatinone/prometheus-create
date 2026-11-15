import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Studio } from "@/components/editor/Studio";
import { nextCookieJar, sessionUser } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Editor" };

export default function EditorPage({ params }: { params: Promise<{ projectId: string }> }) {
  return (
    <Suspense fallback={<p className="p-6 text-muted">Opening the editor…</p>}>
      <EditorForUser params={params} />
    </Suspense>
  );
}

async function EditorForUser({ params }: { params: Promise<{ projectId: string }> }) {
  // Request-time only: the session check reads cookies and the clock.
  await connection();
  const { projectId } = await params;
  const user = await sessionUser(await nextCookieJar());
  if (!user) redirect(`/login?next=${encodeURIComponent(`/projects/${projectId}`)}`);
  return <Studio actor={user.actor} userLabel={user.email ?? user.actor.userId} initialProjectId={projectId} />;
}
