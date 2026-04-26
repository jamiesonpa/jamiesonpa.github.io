# wb-violin-proxy (CORS proxy for warbeacon battle reports)

This is a tiny Cloudflare Worker that exists for one reason: warbeacon's
`GET /api/br/report/<uuid>` JSON endpoint doesn't send
`Access-Control-Allow-Origin`, so the static site at
`https://jamiesonpa.github.io` can't call it directly from the browser.
This worker accepts requests at `/report/<uuid>`, validates the UUID,
forwards to warbeacon, and re-emits the response with CORS headers.

It does **not** accept arbitrary upstream URLs, so it can't be abused as
a generic open proxy.

## One-time setup

1. Install Wrangler (the Cloudflare Workers CLI). Either globally:

    ```sh
    npm install -g wrangler
    ```

   ...or use `npx wrangler` for every command below.

2. Log in to Cloudflare (opens a browser, free account is fine):

    ```sh
    wrangler login
    ```

3. From this directory (`tools/cors-worker/`), deploy:

    ```sh
    wrangler deploy
    ```

   Wrangler will print a URL like:

    ```
    https://wb-violin-proxy.<your-subdomain>.workers.dev
    ```

4. Open `js/analyzer.js` in the parent repo and replace the
   `DEFAULT_PROXY_BASE` placeholder with that URL:

    ```js
    const DEFAULT_PROXY_BASE = "https://wb-violin-proxy.<your-subdomain>.workers.dev";
    ```

5. Commit & push to `jamiesonpa.github.io` (the static site).

## Updating later

If you change `worker.js`, redeploy with:

```sh
wrangler deploy
```

The worker URL stays the same.

## Local testing without redeploying the static site

You can override the proxy URL the analyzer page uses without editing
`analyzer.js`. In the browser console on `analyzer.html`, run:

```js
localStorage.setItem("wb_proxy_base", "https://your-preview-worker.workers.dev");
```

Reload the page; the analyzer will use that URL until you `removeItem` it.
This is helpful if you spin up a second `wrangler deploy --name ...`
preview worker.

## What the worker does, exactly

- Accepts only `GET /report/<uuid>` (and the corresponding CORS preflight `OPTIONS`).
- `<uuid>` must match the canonical 8-4-4-4-12 hex UUID format.
- Forwards to `https://warbeacon.net/api/br/report/<uuid>` with a small
  user-agent and a 5-minute Cloudflare edge cache.
- Returns the upstream body verbatim plus `Access-Control-Allow-Origin`
  set to one of the whitelisted origins (`https://jamiesonpa.github.io`
  by default; `http://localhost:8000` etc. for local dev).

To tighten the origin whitelist, edit `ALLOWED_ORIGINS` at the top of
`worker.js` and redeploy.
