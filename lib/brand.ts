/**
 * Brand constants (docs/DECISIONS.md ADR-001, ADR-002). Colors live as theme
 * tokens in app/globals.css; use the Tailwind classes (bg-canvas, text-ink,
 * hover:text-accent) rather than hex values. The logo is
 * public/prometheus-logo.png (1254x1254); import it statically so next/image
 * gets its dimensions.
 */
export const PRODUCT_NAME = "Prometheus::create";
export const PRODUCT_TAGLINE = "Capture a scene. Make its objects editable. Create another take.";
