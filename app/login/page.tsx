import type { Metadata } from "next";
import { Suspense } from "react";
import { LoadingOverlay } from "@/components/ui/Loading";
import { Logo } from "@/components/ui/Logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="w-full max-w-sm">
        {/* Optically centred: shift left by half the mark plus gap so the wordmark sits on the centre line. */}
        <div className="mb-8 flex justify-center">
          <span className="-translate-x-[22px]">
            <Logo size="lg" />
          </span>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-7 shadow-sm">
          <h1 className="font-serif text-2xl font-semibold">Sign in</h1>
          <p className="mt-2 text-sm text-muted">We email you a one-time code. Projects are private to the account that creates them.</p>
          <Suspense fallback={<div className="relative mt-6 h-40"><LoadingOverlay show /></div>}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
