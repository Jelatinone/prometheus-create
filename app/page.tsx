import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/brand";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-5 py-12">
      <h1 className="text-3xl font-semibold">{PRODUCT_NAME}</h1>
      <p className="mt-2 text-lg text-muted">{PRODUCT_TAGLINE}</p>
      <p className="mt-6 leading-relaxed">
        Turn a captured view into an editable scene, preserve the original, and export another take.
        This build is the shared baseline: contracts, fixtures, and a reference backend. The editor,
        platform, and capture/reconstruction lanes build on it.
      </p>
    </main>
  );
}
