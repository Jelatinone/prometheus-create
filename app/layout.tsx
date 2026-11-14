import type { Metadata } from "next";
import Link from "next/link";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: PRODUCT_TAGLINE,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <header className="flex items-center gap-6 border-b border-line bg-panel px-5 py-3 text-sm">
          <Link href="/" className="font-semibold tracking-wide text-ink">
            {PRODUCT_NAME}
          </Link>
        </header>
        {children}
      </body>
    </html>
  );
}
