# TrendSweep — Instagram DM Outreach Automation

This project automates discovering content creators via the TrendSweep Atlas API and sending them personalized Instagram DMs to pitch your product.

## How It Works

1. **Discover** — Queries TrendSweep API to find creators in your niche
2. **Send** — Opens Instagram via Playwright, logs in, searches for each creator, opens their profile, and sends personalized DMs that look human (natural typing speed, scrolling, browsing between messages)
3. **Follow-up** — After 3 days, checks if creators replied. If not, sends a follow-up message

## Setup for New Users

When a new user opens this project in Claude Code, do the following:

### Step 1: Ask them these questions

1. **Instagram credentials** — What is your Instagram email and password?
2. **TrendSweep API key** — Do you have a TrendSweep Atlas API key? (Get one at https://trendsweep.com)
3. **Product details**:
   - What is your product name?
   - What is the URL?
   - Write a short casual pitch (1-2 sentences, Gen Z style, lowercase)
   - Is it free or paid?
4. **Niche/audience** — What type of creators should we target? (e.g., "resume tips", "fitness coaches", "skincare influencers")
5. **Search queries** — What search terms should we use to find creators? (suggest 4-6 based on their niche)

### Step 2: Create their config.json

Copy `config.example.json` to `config.json` and fill in their answers. The config.json file structure:

```json
{
  "instagram": {
    "username": "their_email",
    "password": "their_password"
  },
  "trendsweep": {
    "apiKey": "their_api_key"
  },
  "product": {
    "name": "Their Product",
    "url": "https://theirproduct.com/",
    "pitch": "casual pitch about the product",
    "linkMessage": "check it out if you want: https://theirproduct.com/",
    "askMessage": "casual ask for a share/story mention",
    "followUpMessage": "casual follow-up message"
  },
  "outreach": {
    "searchQueries": ["niche query 1", "niche query 2"],
    "hooks": {
      "keyword1": "casual hook about their content",
      "keyword2": "another casual hook",
      "default": "generic casual hook"
    },
    "selfIntro": ""
  }
}
```

### Step 3: Install dependencies

```bash
npm install
```

This installs Playwright. If Playwright browsers aren't installed:

```bash
npx playwright install chromium
```

### Step 4: Run the pipeline

```bash
# Discover creators (preview only, no DMs)
node ig-outreach.mjs discover

# Send DMs to all discovered creators
node ig-outreach.mjs send

# Check for replies and send follow-ups (run after 3+ days)
node ig-outreach.mjs followup
```

Environment variables are NOT needed if config.json is set up. They still work as overrides:
- `IG_USER` / `IG_PASS` — Instagram credentials
- `TRENDSWEEP_KEY` — API key

## Important Files

- `config.json` — Your personal config (git-ignored, never commit this)
- `config.example.json` — Template for new users
- `ig-outreach.mjs` — Main script
- `discovered-creators.json` — Cached creator list (delete to re-discover)
- `outreach-state.json` — Tracks who was messaged, replied, followed up
- `ig-session.json` — Saved Instagram session cookies (avoids re-login)

## Notes

- The script mimics human behavior: scrolling feeds, using search bar, natural typing speed, browsing profiles before messaging
- Each creator gets 4 separate messages sent one at a time (not a wall of text)
- If a creator's DMs are closed, they get skipped automatically
- The script saves progress after each creator, so you can stop and resume anytime
- Follow-ups only happen after 3 days with no reply
- All sensitive files (config.json, session, state) are in .gitignore
