# May Meital Event Form

Single-page web form for DeClub to capture signups for May Meital's event. Form posts to a Trigger.dev webhook (in the De Club General project) and redirects the user to an Arbox payment page.

## Setup

1. Clone the repo:
   ```bash
   git clone git@github.com:De-Club-TLV/may-meital-form.git
   cd may-meital-form
   ```
2. Copy env template:
   ```bash
   cp .env.example .env
   ```
3. Fill in `TRIGGER_WEBHOOK_URL`, `ARBOX_PURCHASE_URL`, and `FORM_STATUS_URL` in `.env`.

## Run locally

```bash
npx serve . -p 4321
```

Open `http://localhost:4321`.

## Deploy

Push to `main`. Netlify auto-deploys from the connected GitHub repo.

## Structure

```
.
├── index.html         # the form page
├── script.js          # submit + capacity check
├── styles.css         # DeClub brand styling
├── netlify.toml       # Netlify build config
├── .claude/           # Claude Code config and agents
├── CLAUDE.md          # project instructions for Dasha
├── SESSION_LOG.md     # work session log
├── .env.example       # environment variable template
└── README.md
```

## Related

The automation (form-handler webhook, Monday item creation, ManyChat flow, Arbox payment cron, capacity logic) lives in the De Club General project at `../../General/`.

## Contributing / Review

- Open a PR against `main`
- Keep the page lightweight, no frameworks unless necessary
- Verify the form submits and redirects correctly on a Netlify preview deploy before merging
