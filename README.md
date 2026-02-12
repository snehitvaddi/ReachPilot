# ReachPilot

Automated Instagram DM outreach tool. Discovers creators in your niche via API search or Instagram native search, screens them using AI vision, and sends personalized DMs with human-like behavior.

## Features

- **Instagram Native Search** — searches keywords, finds creators from reels/posts, opens profiles
- **AI Profile Screening** — GPT-4o-mini vision checks if creator matches your target audience + detects gender
- **Personalized DMs** — gender-based greetings ("Hey bro!" for males, "Hey!" for others), keyword-matched hooks
- **Human-Like Behavior** — natural typing speed, feed browsing, profile scrolling, random mouse movements
- **3-Level Tab Management** — search results tab > post tab > profile tab (clean open/close lifecycle)
- **Auto-Debug** — captures screenshots + HTML + link dumps whenever something fails
- **Follow-Up System** — checks for replies after 3 days, sends follow-ups to non-responders
- **Live Dashboard** — real-time web dashboard showing sent DMs, screening stats, and follow-up queue

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/snehitvaddi/ReachPilot.git
cd ReachPilot
npm install
npx playwright install chromium
```

### 2. Configure

```bash
cp config.example.json config.json
```

Edit `config.json` with your details:

| Field | Description |
|---|---|
| `instagram.username` | Your Instagram email |
| `instagram.password` | Your Instagram password |
| `instagram.handle` | Your Instagram handle (to avoid messaging yourself) |
| `trendsweep.apiKey` | TrendSweep API key (optional, for API-based discovery) |
| `openai.apiKey` | OpenAI API key (optional, for AI screening + gender detection) |
| `screening.enabled` | `true` to enable AI audience screening |
| `screening.targetAudience` | e.g. "Indian or South Asian" |
| `product.*` | Your product name, URL, pitch, and follow-up messages |
| `outreach.searchQueries` | API search queries for creator discovery |
| `outreach.igSearchQueries` | Short keywords for Instagram native search |
| `outreach.hooks` | Keyword-matched casual openers |

### 3. Run

```bash
# Search Instagram natively for creators + screen + DM (recommended)
node reachpilot.mjs igsearch

# Discover creators via TrendSweep API (preview only, no DMs)
node reachpilot.mjs discover

# Send DMs to all discovered creators from API
node reachpilot.mjs send

# Check for replies and send follow-ups (run after 3+ days)
node reachpilot.mjs followup
```

### 4. Stop

Press **Ctrl+C** in the terminal. The script saves progress after each creator, so you can safely stop and resume anytime — it will skip creators who were already messaged.

## Dashboard

### Live Dashboard (auto-refreshes every 5 seconds)

```bash
node dashboard-server.mjs
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Shows real-time stats including DMs sent, screening results, follow-up queue, and match rate. The dashboard reads directly from `outreach-state.json` and auto-refreshes.

### Static Dashboard

```bash
node generate-dashboard.mjs
open dashboard.html
```

Generates a one-time HTML snapshot of your campaign stats.

### Reports

```bash
node generate-reports.mjs
```

Generates `sent-dms.csv`, `results-summary.md`, and `pending-followup.txt`.

## How It Works

```
                    ┌──────────────────────┐
                    │   Instagram Search    │
                    │  (keyword queries)    │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  Search Results Page  │  ← Tab 1 (suggestion)
                    │  Find /p/ post links  │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │    Open Post Page     │  ← Tab 2 (post)
                    │  Extract @username    │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   Open Profile Page   │  ← Tab 3 (profile)
                    │  Screen → Message     │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  Close tabs, next     │
                    │  Save state to JSON   │
                    └──────────────────────┘
```

Each creator gets 4 separate messages sent one at a time (not a wall of text). If a creator's DMs are closed, they get skipped automatically.

## Files

| File | Description |
|---|---|
| `reachpilot.mjs` | Main automation script |
| `config.json` | Your personal config (git-ignored) |
| `config.example.json` | Template for new users |
| `outreach-state.json` | Tracks who was messaged/replied/followed-up (git-ignored) |
| `ig-session.json` | Saved Instagram session cookies (git-ignored) |
| `discovered-creators.json` | Cached creator list from API (git-ignored) |
| `debug/` | Auto-captured screenshots + HTML from failures (git-ignored) |
| `dashboard-server.mjs` | Live web dashboard server |
| `generate-dashboard.mjs` | Static dashboard HTML generator |
| `generate-reports.mjs` | CSV/report generator |
| `STRATEGY.md` | Strategy guide for when to use which method |

## Troubleshooting

When the script encounters a failure (can't find username, Message button, or message input), it automatically saves debug files to the `debug/` folder:
- `.png` screenshots showing what the page looked like
- `.html` files with the full page source
- Log output with profile-like links found on the page

Check these files to diagnose issues without needing to manually inspect the browser.

## Notes

- The script saves progress after each creator — safe to stop and resume
- Profile screening uses GPT-4o-mini vision (costs ~$0.01 per profile)
- Follow-ups only happen after 3 days with no reply
- All sensitive files are in `.gitignore` — never committed
