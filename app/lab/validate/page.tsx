import Link from "next/link";
import { ContractValidator } from "@/components/lab/ContractValidator";
import { GOLDEN_FIXTURES, INVALID_FIXTURES } from "@/fixtures";

export const metadata = { title: "Contract validator" };

export default function ValidatePage() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <Link href="/lab" className="text-sm text-muted hover:text-ink">
        ← Lab
      </Link>
      <h1 className="mt-3 text-2xl font-semibold">Contract validator</h1>
      <p className="mt-2 max-w-3xl text-muted">
        Runs the same zod schemas as the server. Files named like{" "}
        <code className="font-mono text-ink">take-manifest.anything.json</code> select their contract
        automatically. The CLI equivalent is{" "}
        <code className="font-mono text-ink">npm run validate -- auto path/to/file.json</code>.
      </p>
      <div className="mt-6">
        <ContractValidator examples={[...GOLDEN_FIXTURES, ...INVALID_FIXTURES]} />
      </div>
    </main>
  );
}
