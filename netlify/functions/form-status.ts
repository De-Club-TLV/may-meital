// Netlify Function: returns whether the May Meital signup form is open.
// Source of truth is the Netlify env var FORM_OPEN ("true" | "false").
// The /General/ Trigger.dev project flips this var (via the Netlify API)
// once 30 paid signups have been confirmed, then triggers a redeploy so
// the form picks up the new state on the next page load.

interface NetlifyResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

export async function handler(): Promise<NetlifyResponse> {
  const raw = (process.env.FORM_OPEN ?? "true").trim().toLowerCase();
  const open = raw !== "false" && raw !== "0" && raw !== "no";

  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0",
    },
    body: JSON.stringify({ open }),
  };
}
