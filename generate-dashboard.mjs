#!/usr/bin/env node

import fs from "fs";

const stateFile = "./outreach-state.json";

if (!fs.existsSync(stateFile)) {
  console.log("No outreach state found. Run the script first.");
  process.exit(0);
}

const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

// Group by date
const byDate = {};
const followUpDue = [];

for (const [handle, data] of Object.entries(state)) {
  if (data.sent) {
    const date = new Date(data.sentAt).toLocaleDateString();
    if (!byDate[date]) {
      byDate[date] = { sent: [], screenedOut: [], source: { api: 0, ig: 0 } };
    }
    byDate[date].sent.push({ handle, ...data });

    if (data.source === "api") byDate[date].source.api++;
    else byDate[date].source.ig++;

    // Check if follow-up is due (3+ days)
    const sentDate = new Date(data.sentAt);
    const now = new Date();
    const daysDiff = Math.floor((now - sentDate) / (1000 * 60 * 60 * 24));

    if (!data.replied && !data.followedUp && daysDiff >= 3) {
      followUpDue.push({ handle, sentAt: data.sentAt, daysDiff });
    }
  } else if (data.skipped) {
    const date = new Date(data.skippedAt || Date.now()).toLocaleDateString();
    if (!byDate[date]) {
      byDate[date] = { sent: [], screenedOut: [], source: { api: 0, ig: 0 } };
    }
    byDate[date].screenedOut.push({ handle, reason: data.skipReason || "screened out" });
  }
}

// Calculate totals
let totalSent = 0;
let totalScreenedOut = 0;
let totalApiSent = 0;
let totalIgSent = 0;

for (const data of Object.values(byDate)) {
  totalSent += data.sent.length;
  totalScreenedOut += data.screenedOut.length;
  totalApiSent += data.source.api;
  totalIgSent += data.source.ig;
}

// Generate HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ReachPilot Campaign Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
      padding: 20px;
      min-height: 100vh;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      color: white;
      font-size: 2.5em;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
    }
    .subtitle {
      color: rgba(255,255,255,0.9);
      font-size: 1.1em;
      margin-bottom: 30px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      border-radius: 12px;
      padding: 25px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      transition: transform 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 8px 12px rgba(0,0,0,0.15);
    }
    .stat-number {
      font-size: 3em;
      font-weight: bold;
      color: #667eea;
      line-height: 1;
      margin-bottom: 10px;
    }
    .stat-label {
      font-size: 0.95em;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .stat-breakdown {
      margin-top: 12px;
      font-size: 0.85em;
      color: #888;
      padding-top: 12px;
      border-top: 1px solid #eee;
    }
    .section {
      background: white;
      border-radius: 12px;
      padding: 25px;
      margin-bottom: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .section-title {
      font-size: 1.5em;
      margin-bottom: 20px;
      color: #667eea;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .date-block {
      margin-bottom: 25px;
      padding-bottom: 25px;
      border-bottom: 1px solid #eee;
    }
    .date-block:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }
    .date-header {
      font-size: 1.2em;
      font-weight: 600;
      color: #333;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .date-stats {
      display: flex;
      gap: 20px;
      margin-bottom: 15px;
      font-size: 0.9em;
    }
    .date-stat {
      background: #f5f5f5;
      padding: 8px 15px;
      border-radius: 6px;
      font-weight: 500;
    }
    .date-stat.sent { background: #e8f5e9; color: #2e7d32; }
    .date-stat.screened { background: #fff3e0; color: #e65100; }
    .creators-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .creator-tag {
      background: #f0f0f0;
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      color: #555;
      transition: all 0.2s;
    }
    .creator-tag:hover {
      background: #667eea;
      color: white;
      transform: scale(1.05);
    }
    .creator-tag.api::after {
      content: ' 🔍';
      font-size: 0.8em;
    }
    .creator-tag.ig::after {
      content: ' 📱';
      font-size: 0.8em;
    }
    .followup-item {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 15px;
      margin-bottom: 10px;
      border-radius: 6px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .followup-handle {
      font-weight: 600;
      color: #333;
    }
    .followup-days {
      color: #e65100;
      font-size: 0.9em;
      font-weight: 500;
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: #999;
      font-style: italic;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 0.75em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge.api { background: #e3f2fd; color: #1565c0; }
    .badge.ig { background: #fce4ec; color: #c2185b; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 ReachPilot Dashboard</h1>
    <p class="subtitle">Instagram DM Outreach Campaign — Finetune Resume</p>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-number">${totalSent}</div>
        <div class="stat-label">Total DMs Sent</div>
        <div class="stat-breakdown">
          <span class="badge api">${totalApiSent} API</span>
          <span class="badge ig">${totalIgSent} IG Search</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-number">${totalScreenedOut}</div>
        <div class="stat-label">Screened Out</div>
        <div class="stat-breakdown">Not a match for target audience</div>
      </div>

      <div class="stat-card">
        <div class="stat-number">${followUpDue.length}</div>
        <div class="stat-label">Follow-ups Due</div>
        <div class="stat-breakdown">No reply after 3+ days</div>
      </div>

      <div class="stat-card">
        <div class="stat-number">${Object.keys(state).length}</div>
        <div class="stat-label">Total Processed</div>
        <div class="stat-breakdown">Sent + screened out</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">📅 Daily Breakdown</div>
      ${Object.keys(byDate).length === 0
        ? '<div class="empty-state">No activity yet</div>'
        : Object.entries(byDate).sort((a, b) => new Date(b[0]) - new Date(a[0])).map(([date, data]) => `
          <div class="date-block">
            <div class="date-header">📆 ${date}</div>
            <div class="date-stats">
              <div class="date-stat sent">✅ ${data.sent.length} DMs Sent</div>
              <div class="date-stat screened">❌ ${data.screenedOut.length} Screened Out</div>
              <div class="date-stat">🔍 ${data.source.api} API | 📱 ${data.source.ig} IG</div>
            </div>
            ${data.sent.length > 0 ? `
              <div style="margin-top: 12px; color: #666; font-size: 0.9em; font-weight: 500;">✅ Sent to:</div>
              <div class="creators-list">
                ${data.sent.map(c => `<div class="creator-tag ${c.source}">${c.handle}</div>`).join('')}
              </div>
            ` : ''}
          </div>
        `).join('')
      }
    </div>

    ${followUpDue.length > 0 ? `
      <div class="section">
        <div class="section-title">⏰ Follow-ups Needed</div>
        ${followUpDue.map(f => `
          <div class="followup-item">
            <span class="followup-handle">${f.handle}</span>
            <span class="followup-days">${f.daysDiff} days ago</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="section">
      <div class="section-title">ℹ️ Campaign Info</div>
      <div style="line-height: 1.8; color: #555;">
        <p><strong>Product:</strong> Finetune Resume</p>
        <p><strong>Target Audience:</strong> South Asian creators posting about resumes, job search, career advice</p>
        <p><strong>Last Updated:</strong> ${new Date().toLocaleString()}</p>
      </div>
    </div>
  </div>
</body>
</html>`;

fs.writeFileSync("./dashboard.html", html, "utf-8");
console.log("✅ Dashboard generated: dashboard.html");
console.log("📊 Open in browser to view your campaign stats");
