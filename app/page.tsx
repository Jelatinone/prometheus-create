import { redirect } from "next/navigation";

/** The app starts at sign-in; a signed-in visitor is sent on to their saves by the proxy. */
export default function Home() {
  redirect("/login");
}
