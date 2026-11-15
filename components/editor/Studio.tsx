"use client";

/**
 * Studio: the save viewer sits over the editor and slides left to reveal it
 * (Egress pattern). URLs follow the state without a page load:
 * `/projects` shows the saves, `/projects/<id>` the editor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Actor } from "@/lib/contracts/ports";
import { HttpBackend } from "@/lib/platform/http-backend";
import { Editor } from "./Editor";
import { SavesPage } from "./SavesPage";

interface Props {
  actor: NonNullable<Actor>;
  userLabel: string;
  initialProjectId?: string;
}

export function Studio({ actor, userLabel, initialProjectId }: Props) {
  const api = useMemo(() => new HttpBackend(), []);
  const [openId, setOpenId] = useState<string | null>(initialProjectId ?? null);
  const [savesShown, setSavesShown] = useState(!initialProjectId);
  const [refresh, setRefresh] = useState(0);
  const dirty = useRef(false);

  const open = useCallback(
    (projectId: string) => {
      if (projectId !== openId && dirty.current && !window.confirm("Discard unsaved changes to the open project?")) return;
      setOpenId(projectId);
      setSavesShown(false);
      window.history.pushState(null, "", `/projects/${projectId}`);
    },
    [openId],
  );

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
      {openId && <Editor key={openId} projectId={openId} actor={actor} userLabel={userLabel} onShowSaves={showSaves} onDirtyChange={onDirtyChange} />}
      <SavesPage api={api} actor={actor} userLabel={userLabel} active={savesShown} openProjectId={openId} onOpen={open} refreshKey={refresh} />
    </>
  );
}
