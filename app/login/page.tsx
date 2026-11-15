import type { Metadata } from "next";
import { Suspense } from "react";
import { Logo } from "@/components/ui/Logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo size="lg" />
        </div>
        <div className="rounded-2xl border border-line bg-panel p-7 shadow-sm">
          <h1 className="font-serif text-2xl font-semibold">Sign in</h1>
          <p className="mt-2 text-sm text-muted">We email you a one-time code. Projects are private to the account that creates them.</p>
          <Suspense fallback={<p className="mt-6 text-muted">Loading…</p>}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
