# ghost-ai

`shared-backend-api` in `package.json`: *"Shared backend API for Ghost OS,
CyberCheck, and GCR platforms."* One Express backend meant to serve three
separate frontends (`ghostos.ai`, `cybercheck.com`, `gulfcoastradar.com`),
plus `ghost-os-frontend/` — the marketing site for Ghost OS.

## ⚠ A fully-configured `.env` is committed, six services deep

`backend-api/.env` is tracked in git, committed since 2026-01-24 — the oldest
of the leaks found in this pass. Its own comments say `✅ CONFIGURED` next to
each of: **Twilio** (Account SID + Auth Token), **OpenAI**, **Perplexity**,
**Grok**, and **Supabase** (URL + service-role key + anon key) — for Supabase
project ref `lvmsmjlallptylonscat`, a fifth distinct project ref found across
this estate (alongside `mkepugvdlktfsossumox` / cyber check,
`adpnhipmdefutkzzltbs` / gulf coast radar, `xbptmkpbiqzvxptjkfoi` / launch
gcr, and `mhafixflyffflwjhcgfn` / check-mate-api-). Flagged, not rotated.

`backend-api/node_modules/` is also tracked — 13,205 files. Not a security
issue, but worth a `.gitignore` and a history cleanup; every clone of this
repo currently pulls down a full `node_modules`.

## check-mate-api- is a fork of this repo

`backend-api/src/routes/cybercheck/menu.js` (1,189 lines) and
`check-mate-api-/routes/checkmate/menu.js` (1,201 lines) are the same file —
diffed near-identical. `check-mate-api-`'s version adds an event-router
(`routeEvent`/`EVENT_TYPES`, "Route event to all connected apps" on every
write) on top of what is otherwise this codebase. The route directory names
match one-for-one (`cybercheck/business.js`, `menu.js`, `appointments.js`,
`billing.js`, `sms.js`, `phone.js`, `voice-crm.js`, `social-media.js`, `ai.js`,
`leads.js`, `loyalty.js`, `tasks.js`, `reviews.js`, `contacts.js`, `auth.js`,
`automations.js`, `tools.js`, `dashboard.js`). Whichever came first, these are
not two independent implementations — fixing a bug in one almost certainly
means the same bug exists in the other.

## Layout

```
backend-api/
  src/
    index.js                shared entry — mounts all three platforms' routes,
                            CORS allows ghostos.ai, cybercheck.com,
                            gulfcoastradar.com plus four localhost ports
    index-ghost-ai-only.js   a narrower entry, Ghost AI's routes only
    config/supabase.js
    routes/
      admin/                 integrations, dashboard, auth
      user/platforms.js
      cybercheck/            business, profile, dashboard, auth, appointments,
                            menu, contacts, leads, loyalty, reviews, billing,
                            sms, phone, voice-crm, voiceNotes, social-media,
                            ai, tasks, automations, tools     (18 files)
      ghost-os/demo.js
      gcr/                   gcr.js, gcr-featured.js, public.js
      ghost-ai.js
      waitlist.js
    services/
      phone.service.js, email.service.js, stripe.service.js, ai.service.js,
      sms-ai.service.js, ai-orchestrator.service.js, sms.service.js,
      ocr.service.js, openai.service.js, realtime-voice.service.js,
      voiceDataExtraction.js, runtime-executor.service.js
    workers/
      receiptWorker.js, voiceNoteWorker.js
    middleware/               auth.js, validation.js, errorHandler.js
    config/                   database.js, supabase.js, redis.js, logger.js
  database/
    schema.sql, platform-connections.sql, seeds/example-data.json
  gcr-google-sheets-sync.js
  test-gcr-sync.js
ghost-os-frontend/            index.html, setup.html, simple-ai-call.html,
                              hero-video.mp4 + screenshots — same marketing
                              assets as the-ghost-ai- and ghost-os-platform
```

## Run

```bash
cd backend-api
npm start   # node src/index.js
npm run dev # nodemon src/index.js
```
