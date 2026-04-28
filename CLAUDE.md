# May Meital Event Form

## Project
Single-page web form for **DeClub** to capture signups for May Meital's event. Deployed on **Netlify**.

This repo holds the **form only** (HTML/CSS/JS). All automation (Trigger.dev tasks, Monday item creation, ManyChat flow, Arbox cron reconciliation, capacity logic) lives in the De Club **General** project at `../../General/` and is deployed via Trigger.dev.

## Stack
- Plain HTML / CSS / vanilla JS (no framework, no build step)
- Netlify for hosting + deploy
- Form posts JSON to a Trigger.dev webhook (defined in the General project), then redirects the user to the Arbox purchase page

## Form fields
- Name
- Phone
- Email

## Submit flow (form side)
1. POST `{ name, phone, email }` to `TRIGGER_WEBHOOK_URL`
2. On success, redirect to `ARBOX_PURCHASE_URL`
3. On failure, show inline error and let the user retry

## Capacity (30 paid signups)
The form calls `FORM_STATUS_URL` on page load. If it returns `{ open: false }`, render the "sold out" state instead of the form. The Trigger.dev side flips this flag once 30 paid signups are confirmed.

## Cross-project contracts (owned by /General/)
- **Trigger.dev webhook**: receives the form POST, looks up phone+email in the De Club CRM (Active Members, Membership Leads, Contacts, Expired Contacts; both `+972` and `972` phone formats), creates an item on Monday board `5095357956`:
  - Member match -> Members group
  - Lead match -> Guests group
  - No match -> create lead-contact-manychat (basic lead generation), assign to event, lead source = `events`, then add to Members/Guests per the new record type
  - Connect item to the Contact via `board_relation_mkycredj`
  - Status = `Pending`
  - Trigger ManyChat WhatsApp template: "your signup will be confirmed only after payment"
- **Arbox cron** (every 15 min): pulls Arbox sales for SKU `A1`, matches by phone OR email against pending event items, flips matched items to `Approved`, sends a second ManyChat confirmation message
- **At 30 approved**: flip the form-status flag to `closed`, send Telegram alert to the De Club group

## Commands
- **Run locally**: `npx serve . -p 4321` then open `http://localhost:4321`
- **Deploy**: push to `main`, Netlify auto-deploys from the connected GitHub repo

## Brand tokens (DeClub)
- Background: `#000000`
- Accent (sage): `#D1DCBD` / hover green: `#B0C290`
- Text (cream): `#f5f0e8`, muted: `#b0aba3`
- Fonts: **Figtree** (body), **IBM Plex Mono** (labels, buttons)
- Pill buttons (`border-radius: 100px`), inputs use `12px` radius, uppercase labels with letter-spacing.

## Conventions
- Keep the page self-contained and lightweight
- No build step unless genuinely required
- Mirror DeClub's minimal luxury aesthetic: dark, sage-accented, mono-spaced labels
- Hebrew RTL layout (audience is Israeli)
- Never use em dashes (—) or en dashes (–) in any user-facing copy. Use commas, periods, colons, or parentheses.
- Any change to form fields: update `index.html`, `script.js`, AND notify the General project so the Trigger.dev webhook contract stays in sync

## Agents Policy
Project-specific agents live in `.claude/agents/`. **New agents require Yuval's approval.** Only create one when the task genuinely needs something Dasha's general agents don't cover.
