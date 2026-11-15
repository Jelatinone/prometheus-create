"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { safeNext } from "@/lib/platform/redirect";
import { supabaseBrowser } from "@/lib/platform/supabase-browser";

type Step = "email" | "code";

const field =
  "mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-ink focus:border-accent focus:outline-none";
const button =
  "mt-4 w-full rounded-lg bg-ink px-4 py-2 font-medium text-canvas hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60";
const link = "mx-auto mt-3 block text-sm text-muted underline-offset-2 hover:text-accent hover:underline";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(params.get("error"));

  async function sendCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const redirect = `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}`;
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: redirect },
    });
    setBusy(false);
    if (error) {
      setMessage(`Could not send a code: ${error.message}`);
      return;
    }
    setStep("code");
    setMessage(`We sent a code to ${email}. It expires in about an hour.`);
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const { error } = await supabaseBrowser().auth.verifyOtp({ email, token: code.trim(), type: "email" });
    if (error) {
      setBusy(false);
      setMessage(`That code did not work: ${error.message}`);
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <div className="mt-6">
      {step === "email" ? (
        <form onSubmit={sendCode}>
          <label className="block text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
          />
          <button type="submit" disabled={busy} className={button}>
            {busy ? "Sending…" : "Send code"}
          </button>
          <button
            type="button"
            className={link}
            onClick={() => {
              setStep("code");
              setMessage(null);
            }}
          >
            I already have a code
          </button>
        </form>
      ) : (
        <form onSubmit={verifyCode}>
          <label className="block text-sm font-medium" htmlFor="code-email">
            Email
          </label>
          <input
            id="code-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
          />
          <label className="mt-4 block text-sm font-medium" htmlFor="code">
            One-time code
          </label>
          <input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            pattern="[0-9]{6,10}"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${field} font-mono tracking-widest`}
          />
          <button type="submit" disabled={busy} className={button}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button type="button" className={link} onClick={() => setStep("email")}>
            Use a different email
          </button>
        </form>
      )}
      {message && (
        <p role="status" className="mt-4 text-center text-sm text-muted">
          {message}
        </p>
      )}
    </div>
  );
}
