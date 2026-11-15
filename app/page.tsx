import { redirect } from "next/navigation";

/** Fallback only: proxy.ts redirects "/" before this renders (to /login, or /projects when signed in). */
export default function Home() {
  redirect("/login");
}
