/**
 * ReachPilot — Automated Instagram DM Outreach
 *
 * Discovers creators via TrendSweep Atlas API and sends them
 * personalized Instagram DMs with human-like behavior.
 *
 * Usage:
 *   node ig-outreach.mjs discover   # Find creators (no DMs)
 *   node ig-outreach.mjs send       # Discover + send DMs
 *   node ig-outreach.mjs followup   # Check replies + follow up
 *
 * Config: Copy config.example.json → config.json and fill in your details.
 * Env vars (IG_USER, IG_PASS, TRENDSWEEP_KEY) override config if set.
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const CONFIG_FILE = path.join(DIR, "config.json");
const STATE_FILE = path.join(DIR, "outreach-state.json");
const SESSION_FILE = path.join(DIR, "ig-session.json");
const CREATORS_FILE = path.join(DIR, "discovered-creators.json");

// ── Load config ─────────────────────────────────────────────────────────────

let CONFIG = {};
if (fs.existsSync(CONFIG_FILE)) {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
} else {
  console.warn("No config.json found. Using environment variables only.");
  console.warn("Run: cp config.example.json config.json  — then fill in your details.\n");
}

const TRENDSWEEP_KEY = process.env.TRENDSWEEP_KEY || CONFIG.trendsweep?.apiKey || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || CONFIG.openai?.apiKey || "";
const SCREENING_ENABLED = CONFIG.screening?.enabled ?? false;
const TARGET_AUDIENCE = CONFIG.screening?.targetAudience || "Indian or South Asian";

// ── Profile Screening via OpenAI Vision ─────────────────────────────────────

async function screenProfile(page, handle) {
  if (!SCREENING_ENABLED || !OPENAI_KEY) return true; // skip screening if disabled

  // Scroll to top so profile pic + bio are visible
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(rand(500, 1000));

  const screenshotPath = path.join(DIR, `screen-${handle}.png`);
  await page.screenshot({ path: screenshotPath });

  const imageBase64 = fs.readFileSync(screenshotPath).toString("base64");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 100,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Look at this Instagram profile screenshot. Based on the profile photo, name, bio, and any visible details, does this person appear to be ${TARGET_AUDIENCE}? Reply with ONLY "YES" or "NO" and a brief reason (max 10 words).`,
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${imageBase64}` },
              },
            ],
          },
        ],
      }),
    });

    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "";
    const isMatch = answer.toUpperCase().startsWith("YES");

    log(`  Screening @${handle}: ${answer} → ${isMatch ? "MATCH" : "SKIP"}`);

    // Clean up screenshot
    try { fs.unlinkSync(screenshotPath); } catch {}

    return isMatch;
  } catch (err) {
    log(`  Screening error for @${handle}: ${err.message}. Proceeding anyway.`);
    try { fs.unlinkSync(screenshotPath); } catch {}
    return true; // on error, don't skip
  }
}

// ── TrendSweep API: Discover Creators ───────────────────────────────────────

const SEARCH_QUERIES = CONFIG.outreach?.searchQueries || [
  "resume tips job application career advice for job seekers",
  "how to improve your resume get hired linkedin profile tips",
  "job search coaching career coach resume review interview prep",
  "H1B visa OPT job hunting resume career tips south asian",
  "job market 2026 resume ATS tips women career advice hiring",
  "resume finetuning AI resume builder job application tools",
];

async function queryTrendSweep(query, resultsPerPage = 20) {
  const res = await fetch("https://trendsweep.com/api/v1/atlas/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TRENDSWEEP_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      results_per_page: resultsPerPage,
      include_transcript: true,
    }),
  });
  const data = await res.json();
  if (!data.success) {
    log(`  API error for "${query.slice(0, 40)}...": ${data.error?.message}`);
    return [];
  }
  return data.data.videos || [];
}

const HOOKS = CONFIG.outreach?.hooks || {
  resume: "your resume tips are so real",
  interview: "your interview advice is actually so good",
  visa: "your visa stuff is literally what people need rn",
  linkedin: "your linkedin tips are fire honestly",
  "job search": "your job search content hit different",
  career: "your career content is genuinely helpful",
  hiring: "your hiring takes are so on point",
  layoff: "your take on the layoff stuff is so real",
  default: "your content is genuinely helpful",
};

function generateFirstLine(creator) {
  const desc = (creator.description || creator.caption || "").slice(0, 150).toLowerCase();

  let hook = HOOKS.default;
  for (const [keyword, text] of Object.entries(HOOKS)) {
    if (keyword === "default") continue;
    if (desc.includes(keyword)) { hook = text; break; }
  }

  const name = creator.name || "";
  const greeting = name ? `Hey ${name}!` : "Hey!";
  const selfIntro = CONFIG.outreach?.selfIntro || "";

  return `${greeting} just came across your reel and ${hook}${selfIntro ? ". " + selfIntro : ""}`;
}

async function discoverCreators() {
  log("=== Phase 1: Discovering creators via TrendSweep Atlas API ===\n");

  const allVideos = [];

  for (const query of SEARCH_QUERIES) {
    log(`Querying: "${query.slice(0, 60)}..."`);
    const videos = await queryTrendSweep(query);
    log(`  → ${videos.length} videos`);
    allVideos.push(...videos);
    // Small delay between API calls
    await sleep(500);
  }

  log(`\nTotal raw results: ${allVideos.length}`);

  // Deduplicate by creator handle and filter relevant ones
  const creatorMap = {};

  for (const v of allVideos) {
    const handle = (v.creator || "").replace(/^@/, "").trim();
    if (!handle) continue;

    const caption = v.caption || "";
    const desc = v.description || "";
    const transcript = v.transcript || "";
    const combined = (caption + " " + desc + " " + transcript).toLowerCase();

    // Filter: must have at least 2 career-related keywords
    const careerKeywords = [
      "resume", "job", "career", "hire", "interview", "linkedin",
      "recruiter", "application", "salary", "corporate", "professional",
      "networking", "h1b", "visa", "opt", "layoff", "employment", "ats",
      "internship", "offer", "shortlist",
    ];
    const score = careerKeywords.filter((kw) => combined.includes(kw)).length;
    if (score < 2) continue;

    // Skip if already tracked with more appearances
    if (!creatorMap[handle]) {
      // Try to extract a first name from the caption/description
      let name = null;
      const namePatterns = [
        /(?:hi,?\s*i'?m\s+)(\w+)/i,
        /(?:my name is\s+)(\w+)/i,
        /(?:i'?m\s+)(\w+)(?:,?\s+a\s+)/i,
      ];
      for (const pat of namePatterns) {
        const m = transcript.match(pat);
        if (m) { name = m[1]; break; }
      }

      creatorMap[handle] = {
        handle,
        name,
        platform: v.platform,
        reelUrl: v.original_url || "",
        caption: caption.slice(0, 200),
        description: desc ? desc.slice(0, 200) : "",
        transcript: transcript ? transcript.slice(0, 100) : "",
        careerScore: score,
        appearances: 0,
      };
    }
    creatorMap[handle].appearances++;
    // Keep the reel with the best career score
    if (score > creatorMap[handle].careerScore) {
      creatorMap[handle].careerScore = score;
      creatorMap[handle].reelUrl = v.original_url || creatorMap[handle].reelUrl;
      creatorMap[handle].caption = caption.slice(0, 200);
      creatorMap[handle].description = desc ? desc.slice(0, 200) : "";
    }
  }

  // Sort by appearances * career score (most relevant first)
  let creators = Object.values(creatorMap).sort(
    (a, b) => b.appearances * b.careerScore - a.appearances * a.careerScore
  );

  // Generate personalized first lines
  for (const c of creators) {
    c.firstLine = generateFirstLine(c);
    c.searchTerm = c.handle.replace(/^_+/, ""); // strip leading underscores for search
  }

  log(`\nDiscovered ${creators.length} unique career creators.\n`);

  // Save to file
  fs.writeFileSync(CREATORS_FILE, JSON.stringify(creators, null, 2));
  log(`Saved to ${CREATORS_FILE}\n`);

  // Print summary
  log("Top creators:");
  for (const c of creators.slice(0, 20)) {
    log(
      `  @${c.handle.padEnd(25)} | ${c.platform.padEnd(10)} | score=${c.careerScore} | x${c.appearances} | ${c.reelUrl}`
    );
  }

  return creators;
}

// ── Message templates ───────────────────────────────────────────────────────

if (!CONFIG.product) {
  console.error("Missing 'product' section in config.json. Add your product pitch, URL, and messages.");
  console.error("See config.example.json for the template.");
  process.exit(1);
}

const MESSAGES_AFTER_FIRST = [
  CONFIG.product.pitch,
  CONFIG.product.linkMessage,
  CONFIG.product.askMessage,
];

const FOLLOWUP_MESSAGE = CONFIG.product.followUpMessage ||
  "hey just following up, did you get a chance to check it out? would love your honest thoughts. no pressure at all!";

// ── Utility ─────────────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  return {};
}
function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function loadCreators() {
  if (fs.existsSync(CREATORS_FILE))
    return JSON.parse(fs.readFileSync(CREATORS_FILE, "utf-8"));
  return [];
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function rand(min, max) {
  return min + Math.random() * (max - min);
}
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ── Human-like micro-behaviors ──────────────────────────────────────────────

async function humanScroll(page, times = null) {
  const count = times ?? Math.floor(rand(2, 6));
  for (let i = 0; i < count; i++) {
    const direction = Math.random() > 0.3 ? 1 : -1;
    const distance = Math.floor(rand(200, 600)) * direction;
    await page.mouse.wheel(0, distance);
    await sleep(rand(400, 1500));
  }
}

async function browseFeed(page) {
  log("  Browsing feed...");
  await page.locator('[aria-label="Home"]').first().click().catch(() =>
    page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" })
  );
  await sleep(rand(1500, 3000));
  await dismissPopups(page);
  await humanScroll(page, Math.floor(rand(3, 7)));
  await sleep(rand(500, 2000));
}

async function humanType(page, text) {
  // Standard keys that keyboard.press() accepts
  const PRESSABLE = /^[a-zA-Z0-9 `~!@#$%^&*()\-_=+\[\]{}\\|;:'",.<>/?]$/;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "\n") {
      await page.keyboard.press("Shift+Enter");
      await sleep(rand(80, 200));
      continue;
    }
    if (PRESSABLE.test(char)) {
      await page.keyboard.press(char === " " ? "Space" : char);
    } else {
      // Special unicode chars (em dash, curly quotes, etc.) — use insertText
      await page.keyboard.insertText(char);
    }
    let delay = rand(40, 100);
    if (".!?,;:".includes(char)) delay += rand(80, 250);
    else if (char === " " && Math.random() > 0.7) delay += rand(50, 200);
    if (Math.random() < 0.02) delay += rand(300, 800);
    await sleep(delay);
  }
}

async function idleMouseMove(page) {
  const x = Math.floor(rand(100, 900));
  const y = Math.floor(rand(200, 700));
  await page.mouse.move(x, y, { steps: Math.floor(rand(5, 15)) });
}

async function dismissPopups(page) {
  // Dismiss any "Turn on Notifications", "Not Now", "Save Info" popups
  for (let i = 0; i < 3; i++) {
    try {
      const notNow = page.locator(
        'button:has-text("Not Now"), div[role="button"]:has-text("Not Now")'
      );
      if (await notNow.first().isVisible({ timeout: 2000 })) {
        await notNow.first().click();
        log("  Dismissed popup (Not Now).");
        await sleep(rand(800, 1500));
      } else {
        break;
      }
    } catch { break; }
  }
}

// ── Instagram actions ───────────────────────────────────────────────────────

async function login(page, username, password) {
  log("Navigating to Instagram...");
  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "networkidle",
  });
  await sleep(rand(2000, 4000));

  try {
    const cookieBtn = page.locator(
      'button:has-text("Allow all cookies"), button:has-text("Allow essential and optional cookies"), button:has-text("Accept"), button:has-text("Allow"), button:has-text("Only allow essential cookies")'
    );
    if (await cookieBtn.first().isVisible({ timeout: 3000 }))
      await cookieBtn.first().click();
    await sleep(rand(1000, 2000));
  } catch {}

  // Screenshot to debug what's on screen
  await page.screenshot({ path: path.join(DIR, "debug-login.png") });
  log("Screenshot saved to debug-login.png");

  // Dump all input elements on the page to figure out the right selectors
  log("Scanning page for input fields...");
  const inputs = await page.locator('input').all();
  for (const inp of inputs) {
    const attrs = await inp.evaluate((el) => ({
      name: el.name, type: el.type, placeholder: el.placeholder,
      ariaLabel: el.getAttribute("aria-label"), id: el.id,
    }));
    log(`  input: name="${attrs.name}" type="${attrs.type}" placeholder="${attrs.placeholder}" aria="${attrs.ariaLabel}" id="${attrs.id}"`);
  }

  // Instagram 2026 uses name="email" and name="pass" (not "username"/"password")
  const usernameInput = page.locator(
    'input[name="email"], input[name="username"], input[type="text"]'
  ).first();
  const passwordInput = page.locator(
    'input[name="pass"], input[name="password"], input[type="password"]'
  ).first();

  log("Waiting for login form...");
  await usernameInput.waitFor({ timeout: 15000 });

  log("Typing credentials...");
  await usernameInput.click();
  await sleep(rand(200, 500));
  await humanType(page, username);
  await sleep(rand(300, 800));

  await passwordInput.click();
  await sleep(rand(200, 500));
  await humanType(page, password);
  await sleep(rand(500, 1200));

  // Submit — could be button or input[type="submit"]
  await page.locator('button:has-text("Log in"), button:has-text("Log In"), button[type="submit"], input[type="submit"]').first().click();
  log("Submitted login...");

  await page.waitForURL((url) => !url.pathname.includes("/accounts/login"), {
    timeout: 60000,
  });
  await sleep(rand(3000, 5000));

  // Dismiss "Save login info?", "Turn on Notifications", etc.
  await dismissPopups(page);

  log("Logged in.");
}

async function searchAndOpenProfile(page, searchTerm, handle) {
  log(`  Searching for "${searchTerm}"...`);
  await dismissPopups(page);
  const searchIcon = page.locator('[aria-label="Search"]');
  try {
    await searchIcon.first().waitFor({ timeout: 5000 });
    await searchIcon.first().click();
  } catch {
    log("  Search icon not found, navigating directly...");
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "domcontentloaded" });
    await sleep(rand(2000, 3500));
    return true;
  }

  await sleep(rand(800, 1500));

  const searchInput = page.locator('input[placeholder="Search"]');
  try {
    await searchInput.first().waitFor({ timeout: 5000 });
    await searchInput.first().click();
    await sleep(rand(300, 600));
    await searchInput.first().fill("");
    await sleep(rand(200, 400));
    await humanType(page, searchTerm);
    await sleep(rand(1500, 3000));

    const resultLink = page.locator(`a[href*="/${handle}/"]`);
    try {
      await resultLink.first().waitFor({ timeout: 5000 });
      await resultLink.first().click();
    } catch {
      try {
        await page.locator(`span:has-text("${handle}")`).first().click();
      } catch {
        log(`  @${handle} not in results, navigating directly...`);
        await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "domcontentloaded" });
      }
    }
  } catch {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "domcontentloaded" });
  }

  await sleep(rand(2000, 4000));
  return true;
}

async function browseProfile(page) {
  log("  Browsing their profile...");
  await sleep(rand(1000, 2000));
  await idleMouseMove(page);
  await humanScroll(page, Math.floor(rand(2, 5)));
  await sleep(rand(800, 2000));
  if (Math.random() > 0.4) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    await sleep(rand(500, 1500));
  }
}

async function sendMessages(page, handle, messages) {
  // Dismiss any popups that might be overlaying the page
  await dismissPopups(page);

  // Scroll to top so the Message button is visible
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(rand(500, 1000));

  log(`  Looking for Message button...`);
  const messageBtn = page.locator(
    'div[role="button"]:text-is("Message"), a:text-is("Message"), button:text-is("Message")'
  );

  try {
    await messageBtn.first().waitFor({ timeout: 8000 });
    await sleep(rand(500, 1200));
    await messageBtn.first().click();
    log(`  Clicked Message button.`);
  } catch {
    log(`  !! No Message button for @${handle}. Skipping.`);
    return false;
  }

  // Dismiss any popup that appears after clicking Message (e.g., notifications)
  await sleep(rand(1000, 2000));
  await dismissPopups(page);

  await sleep(rand(2500, 4500));

  const msgInput = page.locator(
    'div[aria-label="Message"][contenteditable="true"], div[role="textbox"][aria-label*="Message"], textarea[placeholder*="Message"]'
  );

  try {
    await msgInput.first().waitFor({ timeout: 10000 });
  } catch {
    log(`  !! No message input for @${handle}. Skipping.`);
    return false;
  }

  if (Math.random() > 0.3) {
    await page.mouse.wheel(0, -200);
    await sleep(rand(800, 2000));
    await page.mouse.wheel(0, 150);
    await sleep(rand(500, 1000));
  }

  for (let i = 0; i < messages.length; i++) {
    log(`  Typing message ${i + 1}/${messages.length}...`);
    await msgInput.first().click();
    await sleep(rand(300, 700));
    await humanType(page, messages[i]);
    await sleep(rand(400, 1000));
    await page.keyboard.press("Enter");
    log(`  Sent message ${i + 1}.`);
    if (i < messages.length - 1) {
      await sleep(rand(1500, 4000));
      if (Math.random() > 0.5) await idleMouseMove(page);
    }
  }

  log(`  All messages sent to @${handle}.`);
  return true;
}

async function checkReply(page, handle) {
  log(`  Checking DMs with @${handle}...`);
  await searchAndOpenProfile(page, handle, handle);
  await sleep(rand(1000, 2000));

  const messageBtn = page.locator(
    'div[role="button"]:text-is("Message"), a:text-is("Message"), button:text-is("Message")'
  );
  try {
    await messageBtn.first().waitFor({ timeout: 6000 });
    await messageBtn.first().click();
  } catch {
    return { replied: false, error: true };
  }

  await sleep(rand(2500, 4000));

  try {
    const rows = await page.locator('div[role="row"]').all();
    log(`  Found ${rows.length} message rows.`);
    return { replied: rows.length > 6, error: false };
  } catch {
    return { replied: false, error: true };
  }
}

// ── Main: Discover ──────────────────────────────────────────────────────────

async function runDiscover() {
  const creators = await discoverCreators();
  log(`\n=== Preview: Messages that would be sent ===\n`);
  for (const c of creators.slice(0, 5)) {
    log(`@${c.handle} (${c.platform})`);
    log(`  Reel: ${c.reelUrl}`);
    log(`  Msg 1: ${c.firstLine}`);
    log(`  Msg 2: ${MESSAGES_AFTER_FIRST[0].slice(0, 80)}...`);
    log(`  Msg 3: ${MESSAGES_AFTER_FIRST[1]}`);
    log(`  Msg 4: ${MESSAGES_AFTER_FIRST[2].slice(0, 80)}...`);
    log("");
  }
  log(`Total: ${creators.length} creators ready. Run with 'send' to DM them.`);
}

// ── Main: Send ──────────────────────────────────────────────────────────────

async function runSend() {
  const username = process.env.IG_USER || CONFIG.instagram?.username;
  const password = process.env.IG_PASS || CONFIG.instagram?.password;

  if (!username || !password) {
    console.error("Set IG_USER/IG_PASS env vars or add instagram credentials to config.json");
    process.exit(1);
  }

  // Phase 1: Discover creators (or reuse existing)
  let creators = loadCreators();
  if (creators.length === 0) {
    creators = await discoverCreators();
  } else {
    log(`Loaded ${creators.length} creators from cache. Delete ${CREATORS_FILE} to re-discover.\n`);
  }

  // Phase 2: Send DMs
  log("=== Phase 2: Sending DMs via Instagram ===\n");

  const state = loadState();
  const hasSession = fs.existsSync(SESSION_FILE);

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext({
    ...(hasSession ? { storageState: SESSION_FILE } : {}),
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    if (hasSession) {
      log("Reusing saved session...");
      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await sleep(3000);
      const isLoggedIn = await page
        .locator('[aria-label="Home"]').first()
        .isVisible({ timeout: 5000 }).catch(() => false);
      if (!isLoggedIn) await login(page, username, password);
      else log("Session valid.");
    } else {
      await login(page, username, password);
    }

    await context.storageState({ path: SESSION_FILE });
    await browseFeed(page);

    for (let ci = 0; ci < creators.length; ci++) {
      const c = creators[ci];

      if (state[c.handle]?.sent) {
        log(`Skipping @${c.handle} — already sent.`);
        continue;
      }
      if (state[c.handle]?.skippedReason === "screening") {
        log(`Skipping @${c.handle} — failed screening.`);
        continue;
      }

      log(`\n── Creator ${ci + 1}/${creators.length}: @${c.handle} ──`);
      log(`  Reel: ${c.reelUrl}`);

      // Browse feed between creators
      if (ci > 0) await browseFeed(page);

      // Search and open profile
      await searchAndOpenProfile(page, c.searchTerm || c.handle, c.handle);

      // Browse their profile
      await browseProfile(page);

      // Screen profile (nationality check via vision API)
      const passesScreening = await screenProfile(page, c.handle);
      if (!passesScreening) {
        log(`  Skipping @${c.handle} — does not match target audience.`);
        state[c.handle] = {
          sent: false, sentAt: null, skipped: true, skippedReason: "screening",
          replied: false, followedUp: false, reelUrl: c.reelUrl,
        };
        saveState(state);
        continue;
      }

      // Build messages
      const allMessages = [
        c.firstLine,
        ...MESSAGES_AFTER_FIRST,
      ];

      // Send
      const success = await sendMessages(page, c.handle, allMessages);

      state[c.handle] = {
        sent: success,
        sentAt: success ? new Date().toISOString() : null,
        skipped: !success,
        replied: false,
        followedUp: false,
        reelUrl: c.reelUrl,
      };
      saveState(state);

      // Go back to feed
      if (success) {
        log("  Back to feed...");
        await page.locator('[aria-label="Home"]').first().click().catch(() =>
          page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" })
        );
        await sleep(rand(2000, 4000));
        await humanScroll(page, Math.floor(rand(2, 4)));
      }
    }

    await context.storageState({ path: SESSION_FILE });

    log("\n========== SUMMARY ==========");
    for (const c of creators) {
      const s = state[c.handle];
      const status = s?.sent ? "SENT" : s?.skippedReason === "screening" ? "SCREENED OUT" : s?.skipped ? "SKIPPED" : "PENDING";
      log(`  @${c.handle.padEnd(25)} — ${status}`);
    }
  } catch (err) {
    console.error("Error:", err.message);
    saveState(state);
  } finally {
    log("Done. Closing in 10s...");
    await sleep(10000);
    await browser.close();
  }
}

// ── Main: Follow-up ─────────────────────────────────────────────────────────

async function runFollowup() {
  const username = process.env.IG_USER || CONFIG.instagram?.username;
  const password = process.env.IG_PASS || CONFIG.instagram?.password;

  if (!username || !password) {
    console.error("Set IG_USER/IG_PASS env vars or add instagram credentials to config.json");
    process.exit(1);
  }

  const creators = loadCreators();
  if (creators.length === 0) {
    console.error("No creators found. Run 'discover' or 'send' first.");
    process.exit(1);
  }

  const state = loadState();
  const hasSession = fs.existsSync(SESSION_FILE);

  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const context = await browser.newContext({
    ...(hasSession ? { storageState: SESSION_FILE } : {}),
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    if (hasSession) {
      await page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded" });
      await sleep(3000);
      const isLoggedIn = await page
        .locator('[aria-label="Home"]').first()
        .isVisible({ timeout: 5000 }).catch(() => false);
      if (!isLoggedIn) await login(page, username, password);
    } else {
      await login(page, username, password);
    }

    await context.storageState({ path: SESSION_FILE });
    await browseFeed(page);

    log("\n========== CHECKING REPLIES ==========\n");

    for (const c of creators) {
      const s = state[c.handle];
      if (!s?.sent) continue;

      await browseFeed(page);
      const result = await checkReply(page, c.handle);

      if (result.replied) {
        log(`  @${c.handle} — REPLIED!`);
        state[c.handle].replied = true;
      } else if (!result.error && !s.followedUp) {
        // Only follow up after 3 days
        const sentDate = new Date(s.sentAt);
        const daysSinceSent = (Date.now() - sentDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceSent < 3) {
          log(`  @${c.handle} — No reply yet, but only ${daysSinceSent.toFixed(1)} days since sent. Waiting for 3 days.`);
          continue;
        }
        log(`  @${c.handle} — No reply after ${daysSinceSent.toFixed(1)} days. Sending follow-up...`);
        const msgInput = page.locator(
          'div[aria-label="Message"][contenteditable="true"], div[role="textbox"][aria-label*="Message"], textarea[placeholder*="Message"]'
        );
        try {
          await msgInput.first().waitFor({ timeout: 5000 });
          await msgInput.first().click();
          await sleep(rand(300, 700));
          await humanType(page, FOLLOWUP_MESSAGE);
          await sleep(rand(400, 900));
          await page.keyboard.press("Enter");
          log(`  Follow-up sent.`);
          state[c.handle].followedUp = true;
          state[c.handle].followedUpAt = new Date().toISOString();
        } catch {
          log(`  Could not send follow-up.`);
        }
      } else if (s.followedUp) {
        log(`  @${c.handle} — Already followed up.`);
      }
      saveState(state);
    }

    await context.storageState({ path: SESSION_FILE });

    log("\n========== FOLLOW-UP SUMMARY ==========");
    for (const c of creators) {
      const s = state[c.handle];
      if (!s) continue;
      let status = "NOT SENT";
      if (s.replied) status = "REPLIED";
      else if (s.followedUp) status = "FOLLOWED UP";
      else if (s.sent) status = "SENT (awaiting)";
      else if (s.skipped) status = "SKIPPED";
      log(`  @${c.handle.padEnd(25)} — ${status}`);
    }
  } catch (err) {
    console.error("Error:", err.message);
    saveState(state);
  } finally {
    log("Done. Closing in 10s...");
    await sleep(10000);
    await browser.close();
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

const mode = process.argv[2];

if (mode === "discover") runDiscover();
else if (mode === "send") runSend();
else if (mode === "followup") runFollowup();
else {
  console.log(`
TrendSweep → Instagram DM Outreach Pipeline
=============================================

  TRENDSWEEP_KEY=ak_... node ig-outreach.mjs discover
    → Query TrendSweep API, find creators, preview messages (no DMs sent)

  IG_USER=you IG_PASS=pass TRENDSWEEP_KEY=ak_... node ig-outreach.mjs send
    → Discover creators + send personalized DMs on Instagram

  IG_USER=you IG_PASS=pass node ig-outreach.mjs followup
    → Check for replies + send follow-up messages

Files:
  discovered-creators.json  — Cached creator list from TrendSweep
  outreach-state.json       — Tracks sent/replied/followed-up per creator
  ig-session.json           — Instagram session cookies (auto-login)
  `);
}
