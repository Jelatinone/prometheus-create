import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { NewFixtureProject } from "./new-fixture-project";

export const metadata: Metadata = { title: "New example project" };

export default function NewProjectPage() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <Logo />
      <Link href="/projects" className="mt-6 flex w-fit items-center gap-1.5 text-sm text-muted hover:text-accent">
        <ArrowLeftIcon className="size-4" />
        Saves
      </Link>
      <h1 className="mt-3 font-serif text-2xl font-semibold">New example project</h1>
      <p className="mt-2 leading-relaxed text-muted">
        Creates a private project with a labeled axis box in its first take.
      </p>
      <NewFixtureProject />
    </main>
  );
}
