/** Post-sign-in destination: same-origin paths only (no open redirects). */
export const DEFAULT_AFTER_SIGN_IN = "/projects";

export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return DEFAULT_AFTER_SIGN_IN;
  // URL parsers drop tabs and newlines and treat "\\" as "/", so "/\t/evil.example" would leave this origin.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return DEFAULT_AFTER_SIGN_IN;
  try {
    if (new URL(value, "http://same-origin.invalid").origin !== "http://same-origin.invalid") return DEFAULT_AFTER_SIGN_IN;
  } catch {
    return DEFAULT_AFTER_SIGN_IN;
  }
  return value;
}
