/** Post-sign-in destination: same-origin paths only (no open redirects). */
export const DEFAULT_AFTER_SIGN_IN = "/projects";

export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return DEFAULT_AFTER_SIGN_IN;
  return value;
}
