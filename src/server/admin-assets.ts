/**
 * Static assets for the small management dashboard.
 *
 * The dashboard is served from the same origin as the API, so its JavaScript
 * can use the bearer token the administrator signed in with. A strict content
 * security policy keeps it that way: no inline scripts, styles, or remote
 * resources are allowed.
 */

const ADMIN_ROOT = new URL("../../web/admin/", import.meta.url);

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

interface AdminAsset {
  file: string;
  contentType: string;
}

const ASSETS = new Map<string, AdminAsset>([
  ["/admin", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/admin/", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/admin/index.html", { file: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/admin/styles.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/admin/app.css", { file: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/admin/app.js", { file: "app.js", contentType: "text/javascript; charset=utf-8" }],
]);

export function isAdminAssetPath(path: string): boolean {
  return ASSETS.has(path);
}

export async function serveAdminAsset(path: string): Promise<Response | null> {
  const asset = ASSETS.get(path);
  if (!asset) return null;

  const headers = new Headers({
    "content-type": asset.contentType,
    "cache-control": "no-cache",
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
  });

  try {
    const body = await Deno.readFile(new URL(asset.file, ADMIN_ROOT));
    return new Response(body, { status: 200, headers });
  } catch {
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response("The Pulsewire dashboard assets are unavailable.", {
      status: 500,
      headers,
    });
  }
}
