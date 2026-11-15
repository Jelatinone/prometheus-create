import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { Studio } from "@/components/editor/Studio";
import { LoadingScreen } from "@/components/ui/Loading";
import { nextCookieJar, sessionUser } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Saves" };

/** The save viewer; opening a project slides it away to reveal the editor. */
export default function ProjectsPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <SavesForUser />
    </Suspense>
  );
}

async function SavesForUser() {
  // Request-time only: the session check reads cookies and the clock.
  await connection();
  const user = await sessionUser(await nextCookieJar());
  if (!user) redirect("/login?next=/projects");
  return <Studio actor={user.actor} />;
}
