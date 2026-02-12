/**
 * ReachPilot — Automated Instagram DM Outreach
 *
 * Discovers creators via API search or Instagram native search,
 * and sends them personalized Instagram DMs with human-like behavior.
 *
 * Usage:
 *   node reachpilot.mjs discover    # Find creators via API (no DMs)
 *   node reachpilot.mjs send        # Discover + send DMs
 *   node reachpilot.mjs igsearch    # Search Instagram directly + send DMs
 *   node reachpilot.mjs followup    # Check replies + follow up
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

// ── Debug Helper ─────────────────────────────────────────────────────────────

const DEBUG_DIR = path.join(DIR, "debug");
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

async function debugCapture(page, label) {
  const ts = Date.now();
  const safeName = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  try {
    const screenshotPath = path.join(DEBUG_DIR, `${safeName}-${ts}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    log(`      📸 Debug screenshot: debug/${safeName}-${ts}.png`);

    const htmlPath = path.join(DEBUG_DIR, `${safeName}-${ts}.html`);
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, "utf-8");
    log(`      📄 Debug HTML: debug/${safeName}-${ts}.html`);

    // Also extract and log all <a href="/username/"> style links for quick diagnosis
    const links = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href^="/"]')]
        .map(a => a.href.replace(window.location.origin, ''))
        .filter(h => /^\/[a-zA-Z0-9._]+\/?$/.test(h))
        .slice(0, 20);
    });
    if (links.length > 0) {
      log(`      🔗 Profile-like links found: ${links.join(', ')}`);
    } else {
      log(`      🔗 No profile-like links found on page`);
    }

    return { screenshotPath, htmlPath, links };
  } catch (err) {
    log(`      ⚠️ Debug capture failed: ${err.message}`);
    return null;
  }
}

// ── Profile Screening via OpenAI Vision ─────────────────────────────────────

async function screenProfile(page, handle) {
  if (!SCREENING_ENABLED || !OPENAI_KEY) return { passes: true, gender: "unknown" }; // skip screening if disabled

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
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Look at this Instagram profile screenshot. Answer these questions:
1. Does this person appear to be ${TARGET_AUDIENCE}? Reply with "YES" or "NO"
2. What is their apparent gender? Reply with "male", "female", or "unknown"

Format your response as: MATCH: YES/NO | GENDER: male/female/unknown | REASON: (brief reason, max 15 words)`,
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

    // Parse response
    const isMatch = answer.toUpperCase().includes("MATCH: YES");
    let gender = "unknown";
    const genderMatch = answer.match(/GENDER:\s*(male|female|unknown)/i);
    if (genderMatch) {
      gender = genderMatch[1].toLowerCase();
    }

    log(`  Screening @${handle}: ${answer} → ${isMatch ? "MATCH" : "SKIP"} (${gender})`);

    // Clean up screenshot
    try { fs.unlinkSync(screenshotPath); } catch {}

    return { passes: isMatch, gender };
  } catch (err) {
    log(`  Screening error for @${handle}: ${err.message}. Proceeding anyway.`);
    try { fs.unlinkSync(screenshotPath); } catch {}
    return { passes: true, gender: "unknown" }; // on error, don't skip
  }
}

// ── Creator Discovery API ───────────────────────────────────────────────────

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

function generateFirstLine(creator, gender = "unknown") {
  const desc = (creator.description || creator.caption || "").slice(0, 150).toLowerCase();

  let hook = HOOKS.default;
  for (const [keyword, text] of Object.entries(HOOKS)) {
    if (keyword === "default") continue;
    if (desc.includes(keyword)) { hook = text; break; }
  }

  const name = creator.name || "";
  let greeting;

  if (name) {
    greeting = `Hey ${name}!`;
  } else if (gender === "male") {
    greeting = "Hey bro!";
  } else {
    greeting = "Hey!";
  }

  const selfIntro = CONFIG.outreach?.selfIntro || "";

  return `${greeting} just came across your reel and ${hook}${selfIntro ? ". " + selfIntro : ""}`;
}

async function discoverCreators() {
  log("=== Phase 1: Discovering creators via API ===\n");

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
    log(`  !! No Message button for @${handle}. Capturing debug...`);
    await debugCapture(page, `no-msg-btn-${handle}`);
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
    log(`  !! No message input for @${handle}. Capturing debug...`);
    await debugCapture(page, `no-msg-input-${handle}`);
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
      const screenResult = await screenProfile(page, c.handle);
      if (!screenResult.passes) {
        log(`  Skipping @${c.handle} — does not match target audience.`);
        state[c.handle] = {
          sent: false, sentAt: null, skipped: true, skippedReason: "screening",
          replied: false, followedUp: false, reelUrl: c.reelUrl,
        };
        saveState(state);
        continue;
      }

      // Build messages with personalized greeting based on gender
      const firstLine = generateFirstLine({
        handle: c.handle,
        name: c.name,
        description: c.description,
        caption: c.caption,
      }, screenResult.gender);

      const allMessages = [
        firstLine,
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

// ── Instagram Search: extract creator handle from post/reel dialog ──────────

async function extractCreatorHandle(page) {
  const selectors = [
    'article header a[href^="/"]',
    'div[role="dialog"] header a[href^="/"]',
    'div[role="dialog"] a[href^="/"][role="link"]',
    'section > main a[href^="/"][role="link"]',
  ];
  const skip = new Set([
    "explore", "reels", "reel", "accounts", "direct",
    "stories", "p", "about", "legal", "privacy", "terms",
  ]);
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      const href = await el.getAttribute("href", { timeout: 2000 });
      if (!href) continue;
      const m = href.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (!m || skip.has(m[1])) continue;
      return m[1];
    } catch {}
  }
  return null;
}

// ── Instagram Search: capture suggestions + search each one ──────────────────

async function searchInstagramForCreators(page, query, state) {
  const found = [];

  log(`  📝 Typing query: "${query}"`);

  // ── Step 1: Open search and type to get suggestions ──
  await dismissPopups(page);

  // Click search icon
  const searchIcon = page.locator('[aria-label="Search"]');
  try {
    await searchIcon.first().waitFor({ timeout: 5000 });
    await searchIcon.first().click();
  } catch {
    log(`  ⚠️ Search icon not found`);
    return found;
  }
  await sleep(rand(800, 1500));

  // Type the query
  const searchInput = page.locator('input[placeholder="Search"]');
  try {
    await searchInput.first().waitFor({ timeout: 5000 });
    await searchInput.first().click();
    await searchInput.first().fill("");
    await humanType(page, query);
    await sleep(rand(2500, 3500));
  } catch (err) {
    log(`  ⚠️ Could not type in search: ${err.message}`);
    return found;
  }

  // ── Step 2: Extract suggestion URLs from dropdown ──
  log(`  🔍 Extracting search suggestion URLs...`);

  const suggestionUrls = [];

  try {
    // Find all keyword suggestion links using correct selector from HTML
    const suggestionLinks = await page.locator('a[role="link"]:has(svg[aria-label="Keyword"])').all();

    log(`  ✓ Found ${suggestionLinks.length} suggestions`);

    // Extract hrefs from first 5 suggestions
    for (let i = 0; i < Math.min(suggestionLinks.length, 5); i++) {
      const href = await suggestionLinks[i].getAttribute('href');
      if (href) {
        const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
        suggestionUrls.push(fullUrl);
        log(`    → ${fullUrl}`);
      }
    }
  } catch (err) {
    log(`  ⚠️ Could not extract suggestions: ${err.message}`);
  }

  // Close search panel
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(rand(500, 1000));

  if (suggestionUrls.length === 0) {
    log(`  ⚠️ No suggestions found, using original query only`);
    const encodedQuery = encodeURIComponent(query);
    suggestionUrls.push(`https://www.instagram.com/explore/search/keyword/?q=${encodedQuery}`);
  }

  // ── Step 3: Open each suggestion in NEW TAB and process reels ──
  const context = page.context();

  for (let i = 0; i < suggestionUrls.length; i++) {
    let suggestionTab = null;

    try {
      log(`\n  🔎 [${i + 1}/${suggestionUrls.length}] Opening suggestion in new tab...`);

      // Open suggestion in NEW TAB
      suggestionTab = await context.newPage();
      await suggestionTab.goto(suggestionUrls[i]);
      await sleep(rand(4000, 6000));
      await dismissPopups(suggestionTab);

      // Find posts on this suggestion's results page (Instagram shows reels as /p/ or /reel/ links in search)
      const reelLinks = await suggestionTab.locator('a[href*="/p/"], a[href*="/reel/"]').all();
      log(`    Found ${reelLinks.length} posts in suggestion ${i + 1}`);

      // Debug: capture suggestion page if no posts found
      if (reelLinks.length === 0) {
        log(`    ⚠️ No posts found on suggestion page, capturing debug...`);
        await debugCapture(suggestionTab, `suggestion-${i + 1}-empty`);
      }

      // Extract reel URLs (limit to 24 per suggestion), deduplicate
      const reelUrls = [];
      const seenUrls = new Set();
      for (let j = 0; j < Math.min(reelLinks.length, 24); j++) {
        const href = await reelLinks[j].getAttribute('href');
        if (href) {
          const fullUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
          if (!seenUrls.has(fullUrl)) {
            seenUrls.add(fullUrl);
            reelUrls.push(fullUrl);
          }
        }
      }
      log(`    Unique post URLs to process: ${reelUrls.length}`);

      // ── Process each post in ANOTHER NEW TAB ──
      for (let j = 0; j < reelUrls.length; j++) {
        let postTab = null;
        let profileTab = null;

        try {
          log(`    [Post ${j + 1}/${reelUrls.length}] Opening post in new tab...`);

          // Open post in ANOTHER NEW TAB
          postTab = await context.newPage();
          await postTab.goto(reelUrls[j]);
          await sleep(rand(2500, 4000));
          await dismissPopups(postTab);

          // Extract username from post page using multiple strategies
          log(`      Extracting username from post page...`);

          let handle = null;

          // Strategy 1: Look for the post author link in the page via JS evaluation
          // This is the most reliable — directly evaluates the DOM
          try {
            handle = await postTab.evaluate(() => {
              const skipPages = new Set(["explore", "reels", "reel", "accounts", "direct", "stories", "p", "tv", "about", "legal", "privacy", "terms", "tags", "locations"]);

              // Try: links inside spans that look like usernames (Instagram's typical structure)
              const allLinks = document.querySelectorAll('a[href^="/"]');
              for (const a of allLinks) {
                const href = a.getAttribute('href');
                const m = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
                if (!m || skipPages.has(m[1])) continue;

                // Prioritize links that contain a span with the username text
                // (these are typically the author username in post headers)
                const span = a.querySelector('span');
                if (span && span.textContent.trim() === m[1]) {
                  return m[1];
                }
              }

              // Fallback: first link that looks like /username/
              for (const a of allLinks) {
                const href = a.getAttribute('href');
                const m = href.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
                if (m && !skipPages.has(m[1])) return m[1];
              }

              return null;
            });
          } catch {}

          // Strategy 2: Try meta tags (og:url often contains the post author info, or alternate URL)
          if (!handle) {
            try {
              handle = await postTab.evaluate(() => {
                // Check canonical/alternate link or meta property
                const metaAuthor = document.querySelector('meta[property="instapp:owner_user_id"]');
                const ogTitle = document.querySelector('meta[property="og:title"]');
                if (ogTitle) {
                  // og:title is often like "@username on Instagram: ..."
                  const m = ogTitle.content?.match(/@([a-zA-Z0-9._]{1,30})/);
                  if (m) return m[1];
                  // Or "Username on Instagram"
                  const m2 = ogTitle.content?.match(/^([a-zA-Z0-9._]{1,30})\s+on\s+Instagram/i);
                  if (m2) return m2[1];
                }

                // Check title tag
                const title = document.title || "";
                const tm = title.match(/@([a-zA-Z0-9._]{1,30})/);
                if (tm) return tm[1];
                const tm2 = title.match(/^([a-zA-Z0-9._]{1,30})\s+on\s+Instagram/i);
                if (tm2) return tm2[1];

                return null;
              });
            } catch {}
          }

          // Strategy 3: Check the page URL itself (some reels redirect to /reel/ with username in content)
          if (!handle) {
            try {
              const pageUrl = postTab.url();
              // Instagram reel URLs sometimes have /username/reel/xxx pattern
              const urlMatch = pageUrl.match(/instagram\.com\/([a-zA-Z0-9._]{1,30})\/(?:reel|p)\//);
              if (urlMatch) handle = urlMatch[1];
            } catch {}
          }

          if (!handle) {
            log(`      ⚠️ Could not find username on post page, capturing debug...`);
            await debugCapture(postTab, `post-no-username-${j + 1}`);
            await postTab.close();
            continue;
          }

          log(`      ✓ Found username: @${handle}`);

          // Skip own profile (can't message yourself!)
          const ownHandle = CONFIG.instagram?.handle || "";
          if (ownHandle && handle.toLowerCase() === ownHandle.toLowerCase()) {
            log(`      ⊗ Skipping own profile @${handle}`);
            await postTab.close();
            continue;
          }

          // Skip only if successfully sent OR properly screened out
          if (state[handle]) {
            if (state[handle].sent) {
              log(`      ⊗ @${handle} already sent DM`);
              await postTab.close();
              continue;
            } else if (state[handle].skippedReason === "screening") {
              log(`      ⊗ @${handle} failed screening`);
              await postTab.close();
              continue;
            } else {
              // Entry exists but DM failed previously - retry it
              log(`      ⚠️ @${handle} found in state but DM not sent, retrying...`);
            }
          }

          if (found.includes(handle)) {
            log(`      ⊗ @${handle} already found this session`);
            await postTab.close();
            continue;
          }

          // Open profile in NEW TAB by navigating to it
          try {
            log(`      Opening profile for @${handle} in new tab...`);
            profileTab = await context.newPage();
            await profileTab.goto(`https://www.instagram.com/${handle}/`, {
              waitUntil: "domcontentloaded",
            });
            await sleep(rand(2500, 4000));
            await dismissPopups(profileTab);

            log(`      ✓ Profile opened for @${handle}`);

            // Browse profile
            await browseProfile(profileTab);

            // Screen profile with gender detection
            const screenResult = await screenProfile(profileTab, handle);
            if (!screenResult.passes) {
              log(`      Skipping @${handle} — does not match target audience.`);
              state[handle] = {
                sent: false,
                sentAt: null,
                skipped: true,
                skippedReason: "screening",
                skippedAt: new Date().toISOString(),
                replied: false,
                followedUp: false,
                reelUrl: reelUrls[j],
                source: "ig",
              };
              saveState(state);

              // Close profile and post tabs
              await profileTab.close();
              await postTab.close();
              await sleep(rand(1000, 1500));
              continue;
            }

            // Generate personalized first line with gender
            const firstLine = generateFirstLine({
              handle,
              name: null,
              description: "",
              caption: "",
            }, screenResult.gender);

            const allMessages = [firstLine, ...MESSAGES_AFTER_FIRST];

            // Send DMs on profile tab
            const success = await sendMessages(profileTab, handle, allMessages);

            state[handle] = {
              sent: success,
              sentAt: success ? new Date().toISOString() : null,
              skipped: !success,
              replied: false,
              followedUp: false,
              reelUrl: reelUrls[j],
              source: "ig",
            };
            saveState(state);

            if (success) {
              log(`      ✅ DMs sent to @${handle}`);
              found.push(handle);
            }

            // Close profile tab
            await profileTab.close();
            await sleep(rand(800, 1500));

          } catch (err) {
            log(`      ⚠️ Error processing profile for @${handle}: ${err.message}`);
            if (profileTab) {
              await debugCapture(profileTab, `profile-error-${handle}`).catch(() => {});
              await profileTab.close().catch(() => {});
            }
          }

          // Close post tab
          await postTab.close();
          await sleep(rand(1000, 2000));

        } catch (err) {
          log(`      Error processing post ${j + 1}: ${err.message}`);
          // Capture debug from post tab if still open
          if (postTab) {
            await debugCapture(postTab, `post-error-${j + 1}`).catch(() => {});
            await postTab.close().catch(() => {});
          }
          if (profileTab) await profileTab.close().catch(() => {});
          await sleep(500);
        }
      }

      // Close suggestion tab after all reels processed
      log(`    ✓ Closing suggestion ${i + 1} tab`);
      await suggestionTab.close();
      await sleep(rand(1000, 2000));

    } catch (err) {
      log(`    ⚠️ Error with suggestion ${i + 1}: ${err.message}`);
      // Make sure we close the suggestion tab even on error
      if (suggestionTab) {
        await suggestionTab.close().catch(() => {});
      }
      await sleep(500);
    }
  }

  log(`  ✓ Discovered ${found.length} new creators from "${query}" and its suggestions`);
  return found;
}

// ── Main: Instagram Search + DM ─────────────────────────────────────────────

async function runIGSearch() {
  const username = process.env.IG_USER || CONFIG.instagram?.username;
  const password = process.env.IG_PASS || CONFIG.instagram?.password;

  if (!username || !password) {
    console.error("Set IG_USER/IG_PASS env vars or add instagram credentials to config.json");
    process.exit(1);
  }

  log("=== Instagram Search Mode: Discover + DM ===\n");

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
      await page.goto("https://www.instagram.com/", {
        waitUntil: "domcontentloaded",
      });
      await sleep(3000);
      const isLoggedIn = await page
        .locator('[aria-label="Home"]')
        .first()
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      if (!isLoggedIn) await login(page, username, password);
      else log("Session valid.");
    } else {
      await login(page, username, password);
    }

    await context.storageState({ path: SESSION_FILE });
    await browseFeed(page);

    const queries = CONFIG.outreach?.igSearchQueries || [
      "resume tips",
      "job search advice",
      "career coach",
      "h1b visa tips",
      "interview tips",
      "ats resume",
    ];

    let totalDiscovered = 0;
    let totalSent = 0;

    for (const query of queries) {
      log(`\n══ Searching Instagram: "${query}" ══`);
      const newHandles = await searchInstagramForCreators(page, query, state);
      totalDiscovered += newHandles.length;

      for (const handle of newHandles) {
        // Skip own profile (can't message yourself!)
        const ownHandle = CONFIG.instagram?.handle || "";
        if (ownHandle && handle.toLowerCase() === ownHandle.toLowerCase()) {
          log(`  Skipping own profile @${handle}`);
          continue;
        }

        // Skip only if successfully sent OR properly screened out
        if (state[handle]) {
          if (state[handle].sent) {
            log(`  Already sent DM to @${handle}, skipping.`);
            continue;
          } else if (state[handle].skippedReason === "screening") {
            log(`  @${handle} failed screening, skipping.`);
            continue;
          } else {
            // Entry exists but DM failed previously - retry it
            log(`  @${handle} found in state but DM not sent, retrying...`);
          }
        }

        log(`\n  ─ New creator: @${handle} ─`);

        // Open profile in NEW TAB for screening and DMing
        const profileTab = await context.newPage();

        try {
          // Navigate to profile in new tab
          await profileTab.goto(`https://www.instagram.com/${handle}/`, {
            waitUntil: "domcontentloaded",
          });
          await sleep(rand(2000, 3000));
          await dismissPopups(profileTab);
          await browseProfile(profileTab);

          // Screen profile in new tab with gender detection
          const screenResult = await screenProfile(profileTab, handle);
          if (!screenResult.passes) {
            log(`  Skipping @${handle} — does not match target audience.`);
            state[handle] = {
              sent: false,
              sentAt: null,
              skipped: true,
              skippedReason: "screening",
              skippedAt: new Date().toISOString(),
              replied: false,
              followedUp: false,
              reelUrl: "",
              source: "ig-search",
            };
            saveState(state);
            await profileTab.close();
            continue;
          }

          // Generate first line using query keywords for hook matching with gender-based greeting
          const firstLine = generateFirstLine({
            handle,
            name: null,
            description: query,
            caption: query,
          }, screenResult.gender);
          const allMessages = [firstLine, ...MESSAGES_AFTER_FIRST];

          // Send DMs in new tab
          const success = await sendMessages(profileTab, handle, allMessages);
          state[handle] = {
            sent: success,
            sentAt: success ? new Date().toISOString() : null,
            skipped: !success,
            replied: false,
            followedUp: false,
            reelUrl: "",
            source: "ig-search",
          };
          saveState(state);

          if (success) {
            totalSent++;
          }

          // Close profile tab and return to main search page
          await profileTab.close();
          await sleep(rand(1500, 2500));

          // Browse feed in main page between creators
          await browseFeed(page);

        } catch (err) {
          log(`  Error processing @${handle}: ${err.message}`);
          await profileTab.close().catch(() => {});
          continue;
        }
      }

      // Browse feed between searches
      await browseFeed(page);
    }

    await context.storageState({ path: SESSION_FILE });

    log("\n========== IG SEARCH SUMMARY ==========");
    log(`Discovered: ${totalDiscovered} | Sent: ${totalSent}`);
    const igCreators = Object.entries(state).filter(
      ([, s]) => s.source === "ig-search"
    );
    for (const [handle, s] of igCreators) {
      const status = s.sent
        ? "SENT"
        : s.skippedReason === "screening"
          ? "SCREENED OUT"
          : "SKIPPED";
      log(`  @${handle.padEnd(25)} — ${status}`);
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
else if (mode === "igsearch") runIGSearch();
else if (mode === "followup") runFollowup();
else {
  console.log(`
ReachPilot — Automated Instagram DM Outreach
=============================================

  node reachpilot.mjs discover     → Find creators via API (no DMs)
  node reachpilot.mjs send         → Discover creators + send DMs
  node reachpilot.mjs igsearch     → Search Instagram natively + screen + DM
  node reachpilot.mjs followup     → Check replies + send follow-ups

Files:
  discovered-creators.json  — Cached creator list from discovery
  outreach-state.json       — Tracks sent/replied/followed-up per creator
  ig-session.json           — Instagram session cookies (auto-login)
  `);
}
