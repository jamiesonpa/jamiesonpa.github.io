// CORS proxy for warbeacon battle reports.
//
// Why this exists: warbeacon's GET /api/br/report/<uuid> returns JSON but
// does NOT send Access-Control-Allow-Origin. The static GitHub Pages site
// at jamiesonpa.github.io can't fetch it directly. This worker is a
// minimal whitelisted proxy: it accepts ONLY requests for a single
// well-formed UUID under /report/<uuid>, calls warbeacon, and re-emits
// the JSON with CORS headers. It cannot be used to proxy arbitrary URLs.
//
// Deploy: see ./README.md.

const ALLOWED_ORIGINS = [
  "https://jamiesonpa.github.io",
  // Local dev convenience: python -m http.server etc. Remove if you prefer
  // a tighter whitelist.
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5173",
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders(request),
      });
    }

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/report\/([^/]+)\/?$/);
    if (!m || !UUID_RE.test(m[1])) {
      return new Response(
        JSON.stringify({ success: false, error: "Bad request: expected /report/<uuid>" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(request),
          },
        }
      );
    }

    const upstream = `https://warbeacon.net/api/br/report/${m[1]}`;
    const r = await fetch(upstream, {
      headers: {
        "User-Agent": "jamiesonpa-violin-proxy/1.0",
        Accept: "application/json",
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    return new Response(r.body, {
      status: r.status,
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "application/json",
        "Cache-Control": "public, max-age=300",
        ...corsHeaders(request),
      },
    });
  },
};
