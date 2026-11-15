import type { Metadata, Viewport } from "next";
import { ProfileMenu } from "@/components/ui/ProfileMenu";
import { UsageWarning } from "@/components/ui/UsageWarning";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: PRODUCT_TAGLINE,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {children}
        <ProfileMenu />
        {/* USAGE_WARNING=on shows a first-visit paid-API notice (read when the app is built). */}
        {process.env.USAGE_WARNING === "on" && <UsageWarning />}
      </body>
    </html>
  );
}
