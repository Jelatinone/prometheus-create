/**
 * Development-only harness for the capture panel (HK-002), served at
 * /api/capture/lab because the capture lane owns app/api/capture/**. It is a
 * 404 in production builds. The product mounts CapturePanel in the editor's
 * project page (editor lane).
 */
import { notFound } from "next/navigation";
import { CaptureLab } from "@/components/capture/CaptureLab";

export default function CaptureLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <h1 className="text-2xl font-semibold">Capture lab</h1>
      <p className="mt-1 text-sm text-muted">Upload, phone camera, video and FaceTime capture into the common ingestion contract (CT-002).</p>
      <div className="mt-6">
        <CaptureLab />
      </div>
    </main>
  );
}
