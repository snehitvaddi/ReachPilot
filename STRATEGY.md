# ReachPilot Strategy Guide

## 🎯 When to Use Which Method

### TrendSweep API (`discover` + `send`)

**Use when:**
- Starting a new campaign or niche
- Need high-quality, viral content creators quickly
- Want creators with proven engagement
- **ONCE PER DAY MAXIMUM** (API costs + limited calls)

**Pros:**
- ✅ Finds viral creators with transcripts
- ✅ Gets engagement metrics
- ✅ Fast bulk discovery (~100-200 creators in minutes)
- ✅ Includes video transcripts for better targeting

**Cons:**
- ❌ Costs money per search
- ❌ Limited API calls per day/month
- ❌ Mostly non-South Asian results (need manual screening)
- ❌ Can't filter by ethnicity/nationality at API level

**When to run:**
- **Once daily** at start of campaign
- After exhausting Instagram search results
- When expanding to new niches

### Instagram Native Search (`igsearch`)

**Use when:**
- Daily outreach (unlimited, free)
- Need fresh, recent content
- Targeting specific keywords/hashtags
- **RECOMMENDED FOR DAILY USE**

**Pros:**
- ✅ Unlimited searches (no API costs)
- ✅ Fresh, real-time content
- ✅ Direct access to Instagram's full database
- ✅ Can target very specific niches
- ✅ Better for finding smaller creators

**Cons:**
- ❌ Slower (browser automation)
- ❌ Instagram UI can be inconsistent
- ❌ Search results vary by query
- ❌ Still needs manual screening for South Asian

---

## 📅 Recommended Daily Workflow

### Daily Routine (Mon-Fri):
```bash
# Main daily task - Run Instagram search
node reachpilot.mjs igsearch

# Generate reports to track progress
node generate-reports.mjs
node generate-dashboard.mjs
open dashboard.html
```

### Once Per Day (Morning):
```bash
# ONLY if you haven't hit your goal OR trying new niche
node reachpilot.mjs discover
node reachpilot.mjs send
```

### Every 3 Days:
```bash
# Check for replies and send follow-ups
node reachpilot.mjs followup
```

---

## 🎯 Optimizing for South Asian Creators

### TrendSweep API Optimization:
Since TrendSweep API doesn't support ethnicity filtering, we use **smart search queries**:

**Current approach:**
- Add "south asian", "indian", "desi" to search queries
- Include region-specific terms: "H1B", "OPT", "india job market"
- This INCREASES chances but doesn't guarantee South Asian results

**Example optimized queries:**
```json
"searchQueries": [
  "south asian resume tips career advice india job search",
  "indian career coach resume tips H1B visa OPT job",
  "desi creators job market resume advice interview tips"
]
```

### Instagram Search Optimization:
Better targeting since we can browse actual content:
- Check profile photos, bios, names during screening
- Use GPT-4o Vision to screen BEFORE sending DMs
- More accurate but slower

---

## 💰 Cost Analysis

### TrendSweep API:
- **Cost:** ~$X per search (check your plan)
- **Daily limit:** Usually 10-50 searches depending on plan
- **Strategy:** Use sparingly, once per day max

### Instagram Search:
- **Cost:** $0 (just OpenAI screening ~$0.001 per profile)
- **Daily limit:** Unlimited (until Instagram rate limits)
- **Strategy:** Use as main workhorse

### OpenAI Screening:
- **Cost:** ~$0.001 per profile screenshot (GPT-4o-mini)
- **Monthly estimate:** ~$3-5 for 3000-5000 profiles
- **Very cheap compared to sending DMs to wrong audience**

---

## 🚀 Campaign Stages

### Stage 1: Launch (Week 1)
- Run TrendSweep API **once** to discover 100-200 creators
- Run Instagram search **daily** (target: 10-20 new creators/day)
- Goal: 100 total DMs sent

### Stage 2: Scale (Week 2-4)
- Run TrendSweep API **1-2x per week** with new queries
- Run Instagram search **daily** (main source)
- Goal: 300+ total DMs sent

### Stage 3: Optimize (Month 2+)
- Focus on Instagram search **daily**
- Only use TrendSweep for **new niches**
- Start following up with interested creators

---

## 📊 Success Metrics

Track these in your dashboard:

- **Discovery rate:** New creators found per day
- **Screen-out rate:** % filtered by South Asian check
- **Send rate:** DMs sent per day
- **Reply rate:** % who respond (track in follow-ups)
- **Conversion rate:** % who post about your product

**Healthy targets:**
- Find 20-30 new creators/day (Instagram search)
- Screen out ~60-70% (not South Asian)
- Send 8-12 DMs/day (South Asian matches)
- Reply rate: 10-20% (industry standard)
- Conversion: 5-10% post/share

---

## 🔧 Quick Decision Tree

```
Need creators today?
├─ Yes, quick bulk discovery → TrendSweep API (if not used today)
│   └─ Already used API today? → Instagram search
└─ No, daily routine → Instagram search

Found enough creators for today?
├─ Yes → Generate reports and stop
└─ No → Continue Instagram search

Follow-up day (3+ days since last send)?
└─ Yes → Run followup mode
```

---

## ⚠️ Important Rules

1. **TrendSweep API: MAX 1x per day** (costs money + limited calls)
2. **Instagram search: Daily** (free, unlimited)
3. **Always screen for South Asian** (saves wasted DMs)
4. **Follow up after 3 days** (not before, not after 7 days)
5. **Track everything** (generate reports daily)

---

## 🎓 Learning from Results

After 100 DMs sent, analyze your dashboard:

**If screen-out rate > 80%:**
- Instagram search queries are too broad
- Add more specific keywords ("indian", "desi", "south asian")
- Check bio keywords before clicking reels

**If reply rate < 5%:**
- DM message might be too salesy
- Hooks might not be relevant
- Target smaller creators (more engaged)

**If conversion rate < 3%:**
- Offer might not be compelling
- Need to build more rapport before asking
- Consider DM sequence (2-3 messages before ask)
