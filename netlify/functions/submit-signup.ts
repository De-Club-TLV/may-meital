import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Netlify Function: receive a May Meital signup from the form, HMAC-verify
// the raw body, forward to the Trigger.dev `may-meital-signup` task. Trigger.dev
// owns CRM lookup, Monday item creation, ManyChat send, and capacity tracking.
//
// Resilience model:
//  - Browser retries this endpoint 3x with backoff before failing the user.
//  - This function retries the Trigger.dev forward 3x with backoff.
//  - Every call carries an Idempotency-Key derived from phone+email so retries
//    can never create a second Monday item.
//  - On any post-HMAC failure, we Telegram-alert the De Club Alerts group with
//    the full sanitized payload + idempotency key embedded as JSON. That alert
//    is the recovery instrument: a future cron in /General/ picks these up and
//    re-triggers the task. Until then, the alert lets us recover by hand.

const TRIGGER_API = "https://api.trigger.dev/api/v1/tasks/may-meital-signup/trigger";
const TRIGGER_FETCH_ATTEMPTS = 3;
const TRIGGER_PER_ATTEMPT_TIMEOUT_MS = 3000;

interface NetlifyEvent {
  httpMethod?: string;
  headers: Record<string, string | undefined>;
  body: string | null;
}

interface NetlifyResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function json(statusCode: number, body: unknown): NetlifyResponse {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Deterministic key from phone+email so the same submission always produces
// the same key. Trigger.dev de-dupes calls sharing this key for 30 days, so
// browser retries, function retries, and any future recovery automation will
// converge on a single run / single Monday item.
function deriveIdempotencyKey(phone: string, email: string): string {
  return createHash("sha256")
    .update(`${phone.toLowerCase()}|${email.toLowerCase()}|may-meital-signup`)
    .digest("hex")
    .slice(0, 32);
}

interface SignupInput {
  first_name: string;
  last_name: string;
  phone: string;
  phone_country?: string;
  email: string;
}

interface AlertContext {
  reason: string;
  status: number;
  detail?: unknown;
  payload?: SignupInput & { full_name?: string };
  idempotencyKey?: string;
}

// Fire a Telegram alert into the De Club Alerts group. The message contains
// the keyword "error" so the /health-check skill picks it up as a ticket.
// Awaited but wrapped: a Telegram outage must not affect the form response.
async function notifyAlert(ctx: AlertContext): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return;

  const lines: string[] = [
    "🚨 May Meital form error",
    `reason: ${ctx.reason}`,
    `status: ${ctx.status}`,
  ];
  if (ctx.idempotencyKey) lines.push(`idempotency: ${ctx.idempotencyKey}`);
  if (ctx.payload) {
    lines.push("payload:");
    lines.push("```json");
    lines.push(JSON.stringify(ctx.payload, null, 2));
    lines.push("```");
  }
  if (ctx.detail !== undefined) {
    const detailStr =
      typeof ctx.detail === "string"
        ? ctx.detail
        : JSON.stringify(ctx.detail);
    lines.push(`detail: ${detailStr.slice(0, 800)}`);
  }
  const text = lines.join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Swallow. We never want telegram trouble to break the form response.
  }
}

interface ForwardResult {
  ok: boolean;
  status: number;
  bodyText: string;
  runId?: string | null;
  errorMessage?: string;
  attempts: number;
}

async function forwardToTriggerWithRetry(
  signupPayload: object,
  triggerKey: string,
  idempotencyKey: string
): Promise<ForwardResult> {
  let lastBodyText = "";
  let lastStatus = 0;
  let lastErrorMessage = "";

  for (let attempt = 1; attempt <= TRIGGER_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      // 200ms, 400ms exponential backoff between attempts
      await sleep(200 * Math.pow(2, attempt - 2));
    }

    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TRIGGER_PER_ATTEMPT_TIMEOUT_MS);

    try {
      const res = await fetch(TRIGGER_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${triggerKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ payload: signupPayload }),
        signal: ctrl.signal,
      });
      clearTimeout(tid);

      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { id?: string };
        return {
          ok: true,
          status: res.status,
          bodyText: "",
          runId: data.id ?? null,
          attempts: attempt,
        };
      }

      lastStatus = res.status;
      lastBodyText = await res.text().catch(() => "");

      // 4xx from Trigger.dev means our request is wrong (bad payload, auth).
      // Retrying won't help — break early.
      if (res.status >= 400 && res.status < 500) {
        return {
          ok: false,
          status: res.status,
          bodyText: lastBodyText,
          attempts: attempt,
        };
      }
      // 5xx: fall through to retry
    } catch (e) {
      clearTimeout(tid);
      lastErrorMessage = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    bodyText: lastBodyText,
    errorMessage: lastErrorMessage,
    attempts: TRIGGER_FETCH_ATTEMPTS,
  };
}

export async function handler(event: NetlifyEvent): Promise<NetlifyResponse> {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method not allowed" });
    }

    const secret = process.env.MAY_MEITAL_HMAC_SECRET;
    const triggerKey = process.env.TRIGGER_PROD_SECRET_KEY;
    if (!secret || !triggerKey) {
      await notifyAlert({
        reason: "server not configured (missing HMAC secret or Trigger key)",
        status: 500,
      });
      return json(500, { error: "server not configured" });
    }

    const rawBody = event.body ?? "";
    const providedSig =
      event.headers["x-webhook-signature"] ??
      event.headers["X-Webhook-Signature"] ??
      "";

    // Bots and scanners that hit this endpoint without a signature are noise.
    // Skip them silently. Past this point, every failure means a real client
    // tried to submit and we lost their signup.
    if (!providedSig) return json(401, { error: "missing signature" });

    if (!rawBody) {
      await notifyAlert({ reason: "empty body with signature present", status: 400 });
      return json(400, { error: "empty body" });
    }

    const expectedSig = hmacHex(secret, rawBody);
    if (!constantTimeEquals(providedSig, expectedSig)) {
      await notifyAlert({
        reason: "invalid HMAC signature (secret drift between form and function)",
        status: 401,
        detail: rawBody.slice(0, 300),
      });
      return json(401, { error: "invalid signature" });
    }

    let input: SignupInput;
    try {
      input = JSON.parse(rawBody) as SignupInput;
    } catch {
      await notifyAlert({
        reason: "invalid JSON in signed body",
        status: 400,
        detail: rawBody.slice(0, 300),
      });
      return json(400, { error: "invalid JSON" });
    }

    const firstName = (input.first_name ?? "").trim();
    const lastName = (input.last_name ?? "").trim();
    const phone = (input.phone ?? "").trim();
    const email = (input.email ?? "").trim();

    if (!firstName || !lastName || !phone || !email) {
      await notifyAlert({
        reason: "missing required fields after HMAC verify",
        status: 400,
        payload: { first_name: firstName, last_name: lastName, phone, email },
      });
      return json(400, {
        error: "missing required fields (first_name, last_name, phone, email)",
      });
    }

    const signupPayload = {
      first_name: firstName,
      last_name: lastName,
      full_name: `${firstName} ${lastName}`,
      phone,
      phone_country: input.phone_country ?? undefined,
      email,
    };

    const idempotencyKey = deriveIdempotencyKey(phone, email);
    const result = await forwardToTriggerWithRetry(
      signupPayload,
      triggerKey,
      idempotencyKey
    );

    if (!result.ok) {
      await notifyAlert({
        reason: `trigger.dev forward failed after ${result.attempts} attempt(s)`,
        status: 502,
        idempotencyKey,
        payload: signupPayload,
        detail: {
          triggerStatus: result.status,
          body: result.bodyText.slice(0, 500),
          errorMessage: result.errorMessage,
        },
      });
      return json(502, {
        error: "trigger.dev rejected",
        status: result.status,
        attempts: result.attempts,
        detail: result.bodyText.slice(0, 500),
      });
    }

    if (!result.runId) {
      await notifyAlert({
        reason: "trigger.dev 200 but no run id returned",
        status: 502,
        idempotencyKey,
        payload: signupPayload,
      });
    }

    return json(200, { ok: true, runId: result.runId ?? null });
  } catch (err) {
    await notifyAlert({
      reason: "uncaught error in handler",
      status: 500,
      detail: err instanceof Error ? err.message : String(err),
    });
    return json(500, { error: "internal error" });
  }
}
