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

interface SignupInput {
  first_name: string;
  last_name: string;
  phone: string;
  phone_country?: string;
  email: string;
}

export async function handler(event: NetlifyEvent): Promise<NetlifyResponse> {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  const secret = process.env.MAY_MEITAL_HMAC_SECRET;
  const triggerKey = process.env.TRIGGER_PROD_SECRET_KEY;
  if (!secret || !triggerKey) {
    return json(500, { error: "server not configured" });
  }

  const rawBody = event.body ?? "";
  if (!rawBody) return json(400, { error: "empty body" });

  const providedSig =
    event.headers["x-webhook-signature"] ??
    event.headers["X-Webhook-Signature"] ??
    "";
  if (!providedSig) return json(401, { error: "missing signature" });

  const expectedSig = hmacHex(secret, rawBody);
  if (!constantTimeEquals(providedSig, expectedSig)) {
    return json(401, { error: "invalid signature" });
  }

  let input: SignupInput;
  try {
    input = JSON.parse(rawBody) as SignupInput;
  } catch {
    return json(400, { error: "invalid JSON" });
  }

  const firstName = (input.first_name ?? "").trim();
  const lastName = (input.last_name ?? "").trim();
  const phone = (input.phone ?? "").trim();
  const email = (input.email ?? "").trim();

  if (!firstName || !lastName || !phone || !email) {
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
    return json(502, {
      error: "trigger.dev rejected",
      status: res.status,
      detail: text.slice(0, 500),
    });
  }

  const data = (await res.json()) as { id?: string };
  return json(200, { ok: true, runId: data.id ?? null });
}
