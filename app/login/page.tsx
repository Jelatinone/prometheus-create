import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="mx-auto max-w-md px-5 py-12">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-2 text-muted">
        Enter your email and we send a one-time code. Projects are private to the account that creates them.
      </p>
      <Suspense fallback={<p className="mt-6 text-muted">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
