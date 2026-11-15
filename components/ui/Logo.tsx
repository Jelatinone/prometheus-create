import Image from "next/image";
import logo from "@/public/prometheus-logo.png";

/** The wordmark: serif, warm vermilion, with the mark at its left. */
export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const text = size === "lg" ? "text-3xl" : size === "sm" ? "text-base" : "text-xl";
  const mark = size === "lg" ? 36 : size === "sm" ? 20 : 26;
  return (
    <span className={`inline-flex items-center gap-2 font-serif font-semibold tracking-tight text-accent ${text}`}>
      <Image src={logo} alt="" width={mark} height={mark} priority />
      Prometheus::create
    </span>
  );
}
