# Ghost AI

> **Status: the Ghost AI marketing site and its backend, from before the
> current Ghost product. Not part of the box.** "Ghost AI" here is a private AI
> you call or text ($20 a month, about 10,000 tokens, waitlist), which is a
> different offering from the Ghost box the rest of these repos build.

![The Ghost AI landing page](docs/images/site.png)

*`index.html` served as static files. The logo strip above the fold points at
external images, which do not load in an offline capture, so the capture starts
below it.*

## What is in it

| Path | What it holds |
| --- | --- |
| `index.html` | The Ghost AI landing page (hero video, price, waitlist button) |
| `ghost-os-frontend/` | The same site as a deployable folder: `index.html`, `setup.html`, `simple-ai-call.html`, `vercel.json`, an `EMAIL-SETUP.md` |
| `backend-api/` | A shared Express backend for Ghost OS, CyberCheck and Gulf Coast Radar: `src/`, `migrations/`, `database/` (`schema.sql`, `platform-connections.sql`), Twilio and Google Sheets sync scripts, `railway.json`, `vercel.json` |

`ghost-os-platform` holds a related, smaller server (waitlist, admin and
integrations).

## Run it

Static site: serve the folder (`python3 -m http.server`).

Backend:

```bash
cd backend-api
npm install
npm start          # node src/index.js
npm run dev        # nodemon
npm test           # node --test
```

See `backend-api/README.md` and `backend-api/GHOST-AI-SETUP.md` for its settings.
