"use client";

/**
 * Studio: the save viewer sits over the editor and slides left to reveal it
 * (Egress pattern). Opening a project dims the saves with the loading overlay
 * while the editor loads behind it; when the editor is ready the overlay fades
 * and the page slides away. URLs follow the state without a page load:
 * `/projects` shows the saves, `/projects/<id>` the editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Actor } from "@/lib/contracts/ports";
import { HttpBackend } from "@/lib/platform/http-backend";
import { Editor } from "./Editor";
import { SavesPage } from "./SavesPage";

interface Props {
  actor: NonNullable<Actor>;
  initialProjectId?: string;
}

const FADE_MS = 250;

export function Studio({ actor, initialProjectId }: Props) {
  const api = useMemo(() => new HttpBackend(), []);
  const [openId, setOpenId] = useState<string | null>(initialProjectId ?? null);
  const [savesShown, setSavesShown] = useState(!initialProjectId);
  const [opening, setOpening] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const dirty = useRef(false);

  const open = useCallback(
    (projectId: string) => {
      window.history.pushState(null, "", `/projects/${projectId}`);
      if (projectId === openId) return setSavesShown(false); // already loaded behind the saves
      if (dirty.current && !window.confirm("Discard unsaved changes to the open project?")) return;
      setOpening(true);
      setOpenId(projectId);
    },
    [openId],
  );

  /** The editor has its take and meshes: fade the overlay, then slide the saves away. */
  const onReady = useCallback(() => {
    setOpening(false);
    window.setTimeout(() => setSavesShown(false), FADE_MS);
  }, []);

  const showSaves = useCallback(() => {
    setSavesShown(true);
    setRefresh((n) => n + 1);
    window.history.pushState(null, "", "/projects");
  }, []);

  const onDirtyChange = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);

  // Browser back/forward between the saves and the editor.
  useEffect(() => {
    const onPop = () => {
      const match = /^\/projects\/(prj_[a-z0-9_-]+)$/.exec(window.location.pathname);
      if (match) {
        setOpenId(match[1]);
        setSavesShown(false);
      } else setSavesShown(true);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return (
    <>
      {openId && <Editor key={openId} projectId={openId} actor={actor} onShowSaves={showSaves} onDirtyChange={onDirtyChange} onReady={onReady} />}
      <SavesPage api={api} actor={actor} active={savesShown} opening={opening} openProjectId={openId} onOpen={open} refreshKey={refresh} />
    </>
  );
}
