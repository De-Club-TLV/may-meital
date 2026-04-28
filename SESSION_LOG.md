# Session Log

## Spend to date
- Sessions: 1
- Tokens (in / out / cache-read): 1,715 / 594,089 / 233,982,577
- Cost: $459.4264

---

## 2026-04-28

**Focus:** Build and ship the May Meital event signup form end-to-end — Hebrew RTL Netlify site, Trigger.dev intake task, Arbox payment cron, ManyChat double-flow, capacity cap.

**Done:**
- Initialized this repo (`De-Club-TLV/may-meital`) with HTML/CSS/JS form, Netlify Functions, brand assets, scaffolded CLAUDE.md + README + .env.example.
- Built the Hebrew RTL signup page: De Club brand styling, three meta pills (date/time/location), May Meytal portrait + yoga photo with parallax scroll, custom IL-prefix phone field (ditched intl-tel-input after it kept fighting the page's RTL inheritance).
- Wired the form to Trigger.dev via two Netlify Functions: `submit-signup` (HMAC-verifies + forwards to `may-meital-signup` task) and `form-status` (returns `{open: bool}` based on `FORM_OPEN` env var so the form auto-renders sold-out at capacity).
- Custom domain `may-meytal.declub.co.il`: added CNAME in DNS Made Easy, wired to Netlify, Let's Encrypt cert auto-provisioned, HSTS header added.
- Built the **`may-meital-signup`** Trigger.dev task (in `/General/`): Hebrew name transliteration → ManyChat upsert → Monday Contact dedup (phone+email, both `+972` and `972`) → CRM Lead in Initial Contact group (only for new contacts) → event-board participant in Members/Guests group based on contact type, status=Pending → flow #1 (pending payment).
- Built the **`may-meital-payment-cron`** schedule task: every 15 min pulls Arbox `salesReport`, filters by `item_name = "תמיכות במגע"`, matches buyer to a Pending participant by phone/email, flips status to Approved, sends flow #2 (confirmed). At 30 Approved → flips Netlify `FORM_OPEN=false`, redeploys, Telegram alerts the De Club group.
- End-to-end verified in prod: real signup landed (Yuval Katz), flow #1 sent, manual Arbox purchase reconciled by cron, status flipped to Approved, flow #2 sent.
- 2 real signups already in (Noaa Kortzman + Gali Lipinski, both Pending awaiting payment) before session end — pipeline confirmed working under live load.

**Decisions:**
- Single Lead per signup, only on first-time contacts. Returning Members/Leads get an event-board participant but no fresh CRM Lead — they're already in the funnel. Diverges from `lead-intake.ts` (which creates a Lead on every submit) but Yuval explicitly approved.
- Hardcoded `+972` IL prefix on the phone field instead of intl-tel-input. The lib couldn't be coerced into LTR layout against an `<html dir="rtl">` parent without painful overrides; the audience is Israel-only so a country picker was overkill.
- New Leads land directly in **Initial Contact** status/group on the Leads board (skipping the New stage). They're paying for an event, so they're past cold-lead.
- ManyChat / audit-note failures are **non-fatal** — Monday item still gets created, ops can manually follow up. Only Zod validation and Monday `create_item` throw.
- Arbox `salesReport` (not `transactionsReport`) for the cron. Sales has `item_name`, `phone`, `email` per row — exact shape for buyer-to-ticket matching.

**Bugs caught + fixed in flight:**
- `items_page_by_column_values` doesn't support `board_relation` columns — silently throws. Rewrote `findEventParticipantByContact` to iterate items and match by `linkedPulseIds`.
- `column_values.value` returns `null` for board_relation columns in Monday API 2024-10. Switched to the typed `BoardRelationValue.linked_items` GraphQL fragment.
- Status label `{index: N}` on Monday actually wants the label's **id** field, not its `index` field. Had Pending/Approved swapped → `createEventParticipant` was writing Approved instead of Pending. Fixed the constants in `config.ts`.
- `trigger.config.ts` `SYNCED_ENV_NAMES` is an explicit allowlist — new env vars (May Meital + Arbox + Netlify) weren't in it, so prod never saw them. Added.
- Netlify Function bundle bakes env vars at build-time. Setting them via API alone wasn't enough — needed an empty commit to retrigger build.

**Next:**
- Generate `NETLIFY_API_TOKEN` (https://app.netlify.com/user/applications) and add to `/General/.env`, then redeploy. Without it the auto-close-at-30 logs a warning and stops; you'd flip `FORM_OPEN=false` manually in the UI.
- Confirm flow #1 is actually delivering on Meta's side by pinging Noaa or Gali (or wait for the next signup and test live).
- Once the first paying customer flips Pending → Approved in the wild, sanity-check the cron run trace + verify flow #2 reached them.
- Consider stripping the test-mode 0-paid sale of `Yuval Katz` from Arbox so it doesn't pollute counts (or leave it — the cron only matches by phone/email so it won't double-flip anyone).
- If conversion lags below ~30% after 48h, consider a follow-up ManyChat blast to all Pending participants (existing `popup-blast` module supports an audience by-lead-ad-name=`MayMeital`).

**Spend:** $459.4264 this session · tokens in/out/cache-read: 1,715 / 594,089 / 233,982,577
