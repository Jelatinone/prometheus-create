"use client";

import { useState, type HTMLAttributes } from "react";

/**
 * Mounts its content while `show` is true and plays a short leave animation
 * before unmounting, so pop-ups and drawers do not just appear and vanish.
 * The animations are defined in globals.css (and shortened for reduced motion).
 */
export function Presence({
  show,
  enter = "animate-pop",
  className = "",
  children,
  ...rest
}: { show: boolean; enter?: string } & HTMLAttributes<HTMLDivElement>) {
  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true); // derived state: mount as soon as it is asked for
  if (!mounted) return null;
  return (
    <div
      {...rest}
      className={`${className} ${show ? enter : "animate-out pointer-events-none"}`}
      onAnimationEnd={(e) => {
        if (!show && e.target === e.currentTarget) setMounted(false);
      }}
    >
      {children}
    </div>
  );
}
