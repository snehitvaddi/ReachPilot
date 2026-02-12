#!/usr/bin/env node

import http from "http";
import fs from "fs";
import path from "path";

const PORT = 3000;
const stateFile = "./outreach-state.json";

function getStats() {
  if (!fs.existsSync(stateFile)) {
    return {
      totalSent: 0,
      totalScreenedOut: 0,
      followUpDue: 0,
      totalProcessed: 0,
      byDate: {},
      bySentDate: {},
      recentActivity: [],
      sourceBreakdown: { api: 0, ig: 0 },
    };
  }

  const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));

  const byDate = {};
  const bySentDate = {};
  const followUpDue = [];
  const recentActivity = [];
  let totalSent = 0;
  let totalScreenedOut = 0;
  const sourceBreakdown = { api: 0, ig: 0 };

  for (const [handle, data] of Object.entries(state)) {
    if (data.sent) {
      totalSent++;
      const date = new Date(data.sentAt).toLocaleDateString();

      if (!bySentDate[date]) {
        bySentDate[date] = { sent: [], source: { api: 0, ig: 0 } };
      }
      bySentDate[date].sent.push({ handle, ...data });

      if (data.source === "api") {
        bySentDate[date].source.api++;
        sourceBreakdown.api++;
      } else {
        bySentDate[date].source.ig++;
        sourceBreakdown.ig++;
      }

      recentActivity.push({
        type: "sent",
        handle,
        time: data.sentAt,
        source: data.source,
      });

      // Check follow-up
      const sentDate = new Date(data.sentAt);
      const now = new Date();
      const daysDiff = Math.floor((now - sentDate) / (1000 * 60 * 60 * 24));

      if (!data.replied && !data.followedUp && daysDiff >= 3) {
        followUpDue.push({ handle, sentAt: data.sentAt, daysDiff });
      }
    } else if (data.skipped) {
      totalScreenedOut++;
      const date = new Date(data.skippedAt || Date.now()).toLocaleDateString();

      if (!byDate[date]) {
        byDate[date] = { screenedOut: [] };
      }
      byDate[date].screenedOut.push({ handle, reason: data.skipReason });

      recentActivity.push({
        type: "screened",
        handle,
        time: data.skippedAt || Date.now(),
        reason: data.skipReason || "not a match",
      });
    }
  }

  // Sort recent activity by time (newest first)
  recentActivity.sort((a, b) => new Date(b.time) - new Date(a.time));

  return {
    totalSent,
    totalScreenedOut,
    followUpDue: followUpDue.length,
    totalProcessed: Object.keys(state).length,
    byDate,
    bySentDate,
    recentActivity: recentActivity.slice(0, 20), // Last 20 activities
    followUpList: followUpDue,
    sourceBreakdown,
    lastUpdate: new Date().toLocaleString(),
  };
}

function generateHTML(stats) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ReachPilot Live Dashboard</title>
  <meta http-equiv="refresh" content="5">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
      padding: 20px;
      min-height: 100vh;
    }
    .container { max-width: 1400px; margin: 0 auto; }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    h1 {
      color: white;
      font-size: 2.5em;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
      display: flex;
      align-items: center;
      gap: 15px;
    }
    .live-indicator {
      display: inline-block;
      width: 12px;
      height: 12px;
      background: #4ade80;
      border-radius: 50%;
      animation: pulse 2s infinite;
      box-shadow: 0 0 10px #4ade80;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .last-update {
      color: rgba(255,255,255,0.9);
      font-size: 0.9em;
      text-align: right;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      transition: transform 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 6px 12px rgba(0,0,0,0.15);
    }
    .stat-number {
      font-size: 2.5em;
      font-weight: bold;
      color: #667eea;
      line-height: 1;
      margin-bottom: 8px;
    }
    .stat-label {
      font-size: 0.85em;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .stat-breakdown {
      margin-top: 10px;
      font-size: 0.8em;
      color: #888;
      padding-top: 10px;
      border-top: 1px solid #eee;
    }

    .main-content {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 20px;
    }

    .section {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    }
    .section-title {
      font-size: 1.3em;
      margin-bottom: 15px;
      color: #667eea;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 2px solid #f0f0f0;
      padding-bottom: 10px;
    }

    .activity-feed {
      max-height: 600px;
      overflow-y: auto;
    }
    .activity-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px;
      margin-bottom: 8px;
      border-radius: 8px;
      background: #f9f9f9;
      transition: all 0.2s;
    }
    .activity-item:hover {
      background: #f0f0f0;
      transform: translateX(3px);
    }
    .activity-icon {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2em;
      flex-shrink: 0;
    }
    .activity-icon.sent { background: #d4edda; }
    .activity-icon.screened { background: #fff3cd; }
    .activity-details {
      flex: 1;
    }
    .activity-handle {
      font-weight: 600;
      color: #333;
    }
    .activity-time {
      font-size: 0.75em;
      color: #999;
    }
    .activity-meta {
      font-size: 0.8em;
      color: #666;
      margin-top: 2px;
    }

    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 10px;
      font-size: 0.7em;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge.api { background: #e3f2fd; color: #1565c0; }
    .badge.ig { background: #fce4ec; color: #c2185b; }

    .followup-item {
      background: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 12px;
      margin-bottom: 8px;
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
      font-size: 0.85em;
      font-weight: 600;
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: #999;
      font-style: italic;
    }

    .date-summary {
      background: #f8f9fa;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 12px;
    }
    .date-header {
      font-weight: 600;
      color: #333;
      margin-bottom: 8px;
    }
    .date-stats {
      display: flex;
      gap: 15px;
      font-size: 0.85em;
    }
    .date-stat {
      background: white;
      padding: 6px 12px;
      border-radius: 6px;
      font-weight: 500;
    }
    .date-stat.sent { color: #2e7d32; }
    .date-stat.screened { color: #e65100; }

    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #f1f1f1; }
    ::-webkit-scrollbar-thumb { background: #888; border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: #555; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        <span class="live-indicator"></span>
        ReachPilot Live Dashboard
      </h1>
      <div class="last-update">
        🔄 Auto-refresh: 5s<br>
        Last update: ${stats.lastUpdate}
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-number">${stats.totalSent}</div>
        <div class="stat-label">📤 DMs Sent</div>
        <div class="stat-breakdown">
          <span class="badge api">${stats.sourceBreakdown.api} API</span>
          <span class="badge ig">${stats.sourceBreakdown.ig} IG Search</span>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-number">${stats.totalScreenedOut}</div>
        <div class="stat-label">🚫 Screened Out</div>
        <div class="stat-breakdown">Not target audience</div>
      </div>

      <div class="stat-card">
        <div class="stat-number">${stats.followUpDue}</div>
        <div class="stat-label">⏰ Follow-ups Due</div>
        <div class="stat-breakdown">3+ days, no reply</div>
      </div>

      <div class="stat-card">
        <div class="stat-number">${stats.totalProcessed}</div>
        <div class="stat-label">👥 Total Processed</div>
        <div class="stat-breakdown">All creators checked</div>
      </div>

      <div class="stat-card">
        <div class="stat-number">${stats.totalScreenedOut > 0 ? Math.round((stats.totalSent / (stats.totalSent + stats.totalScreenedOut)) * 100) : 0}%</div>
        <div class="stat-label">✅ Match Rate</div>
        <div class="stat-breakdown">Pass screening rate</div>
      </div>
    </div>

    <div class="main-content">
      <div class="section">
        <div class="section-title">📊 Recent Activity</div>
        <div class="activity-feed">
          ${stats.recentActivity.length === 0
            ? '<div class="empty-state">No activity yet. Start the bot to see live updates!</div>'
            : stats.recentActivity.map(a => {
              const timeAgo = getTimeAgo(a.time);
              if (a.type === "sent") {
                return `
                  <div class="activity-item">
                    <div class="activity-icon sent">✅</div>
                    <div class="activity-details">
                      <div class="activity-handle">@${a.handle}</div>
                      <div class="activity-meta">
                        DM sent via <span class="badge ${a.source}">${a.source.toUpperCase()}</span>
                      </div>
                      <div class="activity-time">${timeAgo}</div>
                    </div>
                  </div>
                `;
              } else {
                return `
                  <div class="activity-item">
                    <div class="activity-icon screened">❌</div>
                    <div class="activity-details">
                      <div class="activity-handle">@${a.handle}</div>
                      <div class="activity-meta">Screened out: ${a.reason}</div>
                      <div class="activity-time">${timeAgo}</div>
                    </div>
                  </div>
                `;
              }
            }).join('')
          }
        </div>
      </div>

      <div>
        <div class="section" style="margin-bottom: 20px;">
          <div class="section-title">📅 Daily Breakdown</div>
          ${Object.keys(stats.bySentDate).length === 0
            ? '<div class="empty-state">No DMs sent yet</div>'
            : Object.entries(stats.bySentDate)
                .sort((a, b) => new Date(b[0]) - new Date(a[0]))
                .slice(0, 7)
                .map(([date, data]) => `
                  <div class="date-summary">
                    <div class="date-header">📆 ${date}</div>
                    <div class="date-stats">
                      <div class="date-stat sent">✅ ${data.sent.length} sent</div>
                      <div class="date-stat">🔍 ${data.source.api} API</div>
                      <div class="date-stat">📱 ${data.source.ig} IG</div>
                    </div>
                  </div>
                `).join('')
          }
        </div>

        ${stats.followUpList && stats.followUpList.length > 0 ? `
          <div class="section">
            <div class="section-title">⏰ Follow-ups Needed</div>
            ${stats.followUpList.slice(0, 10).map(f => `
              <div class="followup-item">
                <span class="followup-handle">@${f.handle}</span>
                <span class="followup-days">${f.daysDiff} days ago</span>
              </div>
            `).join('')}
            ${stats.followUpList.length > 10 ? `
              <div style="text-align: center; color: #999; font-size: 0.85em; margin-top: 10px;">
                +${stats.followUpList.length - 10} more
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  </div>

  <script>
    function getTimeAgo(timestamp) {
      const now = new Date();
      const time = new Date(timestamp);
      const diff = Math.floor((now - time) / 1000);

      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
      if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
      return Math.floor(diff / 86400) + ' days ago';
    }
  </script>
</body>
</html>`;
}

function getTimeAgo(timestamp) {
  const now = new Date();
  const time = new Date(timestamp);
  const diff = Math.floor((now - time) / 1000);

  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
  if (diff < 86400) return Math.floor(diff / 3600) + ' hr ago';
  return Math.floor(diff / 86400) + ' days ago';
}

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    const stats = getStats();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(generateHTML(stats));
  } else if (req.url === '/api/stats') {
    const stats = getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 ReachPilot Dashboard running at:`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n📊 Auto-refreshes every 5 seconds`);
  console.log(`⏹  Press Ctrl+C to stop\n`);
});
