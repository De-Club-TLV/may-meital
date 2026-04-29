import { createHmac, timingSafeEqual } from "node:crypto";

// Netlify Function: receive a May Meital signup from the form, HMAC-verify
// the raw body, forward to the Trigger.dev `may-meital-signup` task. Trigger.dev
// owns CRM lookup, Monday item creation, ManyChat send, and capacity tracking.

const TRIGGER_API = "https://api.trigger.dev/api/v1/tasks/may-meital-signup/trigger";

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

function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// Fire a Telegram alert into the De Club Alerts group. The message contains
// the keyword "error" so the /health-check skill picks it up as a ticket.
// Awaited but wrapped: a Telegram outage must not affect the form response.
async function notifyAlert(reason: string, status: number, detail?: unknown): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) return;

  const detailStr =
    detail === undefined
      ? ""
      : typeof detail === "string"
      ? detail
      : JSON.stringify(detail);
  const text =
    `🚨 May Meital form error\n` +
    `reason: ${reason}\n` +
    `status: ${status}` +
    (detailStr ? `\ndetail: ${detailStr.slice(0, 800)}` : "");

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch {
    // Swallow. We never want telegram trouble to break the form response.
  }
}

interface SignupInput {
  first_name: string;
  last_name: string;
  phone: string;
  phone_country?: string;
  email: string;
}

export async function handler(event: NetlifyEvent): Promise<NetlifyResponse> {
  try {
    if (event.httpMethod !== "POST") {
      return json(405, { error: "method not allowed" });
    }

    const secret = process.env.MAY_MEITAL_HMAC_SECRET;
    const triggerKey = process.env.TRIGGER_PROD_SECRET_KEY;
    if (!secret || !triggerKey) {
      await notifyAlert("server not configured (missing HMAC secret or Trigger key)", 500);
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
      await notifyAlert("empty body with signature present", 400);
      return json(400, { error: "empty body" });
    }

    const expectedSig = hmacHex(secret, rawBody);
    if (!constantTimeEquals(providedSig, expectedSig)) {
      await notifyAlert("invalid HMAC signature (secret drift between form and function)", 401);
      return json(401, { error: "invalid signature" });
    }

    let input: SignupInput;
    try {
      input = JSON.parse(rawBody) as SignupInput;
    } catch {
      await notifyAlert("invalid JSON in signed body", 400, rawBody.slice(0, 300));
      return json(400, { error: "invalid JSON" });
    }

    const firstName = (input.first_name ?? "").trim();
    const lastName = (input.last_name ?? "").trim();
    const phone = (input.phone ?? "").trim();
    const email = (input.email ?? "").trim();

    if (!firstName || !lastName || !phone || !email) {
      await notifyAlert("missing required fields after HMAC verify", 400, {
        first_name: firstName,
        last_name: lastName,
        phone,
        email,
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

    const res = await fetch(TRIGGER_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${triggerKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ payload: signupPayload }),
    });

    if (!res.ok) {
      const text = await res.text();
      await notifyAlert("trigger.dev rejected forward", 502, {
        triggerStatus: res.status,
        body: text.slice(0, 500),
        email,
        phone,
      });
      return json(502, {
        error: "trigger.dev rejected",
        status: res.status,
        detail: text.slice(0, 500),
      });
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      await notifyAlert("trigger.dev 200 but no run id returned", 502, { email, phone });
    }
    return json(200, { ok: true, runId: data.id ?? null });
  } catch (err) {
    await notifyAlert("uncaught error in handler", 500, err instanceof Error ? err.message : String(err));
    return json(500, { error: "internal error" });
  }
}
