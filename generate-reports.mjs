import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./outreach-state.json', 'utf-8'));

// Separate by source and status
const apiSent = [];
const igSearchSent = [];
const screenedOut = [];

Object.entries(data).forEach(([handle, info]) => {
  if (info.sent) {
    const creator = {
      handle: handle,
      sentAt: new Date(info.sentAt).toLocaleString(),
      source: info.source || 'api',
      reelUrl: info.reelUrl || 'N/A'
    };
    if (info.source === 'ig-search') {
      igSearchSent.push(creator);
    } else {
      apiSent.push(creator);
    }
  } else if (info.skippedReason === 'screening') {
    screenedOut.push({ handle, source: info.source || 'api' });
  }
});

// Write sent-dms.csv
const csvHeader = 'Handle,Source,Sent At,Reel URL,Follow-up Due\n';
const csvRows = [...apiSent, ...igSearchSent].map(c =>
  `@${c.handle},${c.source},${c.sentAt},${c.reelUrl},Feb 14 (3 days)`
).join('\n');
fs.writeFileSync('sent-dms.csv', csvHeader + csvRows);

// Write results-summary.md
const apiScreened = screenedOut.filter(s => s.source !== 'ig-search');
const igScreened = screenedOut.filter(s => s.source === 'ig-search');

const summary = `# ReachPilot Campaign Results

Generated: ${new Date().toLocaleString()}

## 📊 Summary

- **Total DMs Sent:** ${apiSent.length + igSearchSent.length}
  - From API Discovery: ${apiSent.length}
  - From Instagram Search: ${igSearchSent.length}
- **Screened Out:** ${screenedOut.length}
- **Follow-up Due:** Feb 14, 2026 (3 days from now)

## ✅ DMs Sent - API Discovery (${apiSent.length})

| # | Handle | Sent At | Reel |
|---|--------|---------|------|
${apiSent.map((c, i) => `| ${i+1} | @${c.handle} | ${c.sentAt} | [View](${c.reelUrl}) |`).join('\n')}

## ✅ DMs Sent - Instagram Search (${igSearchSent.length})

| # | Handle | Sent At |
|---|--------|---------|
${igSearchSent.map((c, i) => `| ${i+1} | @${c.handle} | ${c.sentAt} |`).join('\n')}

## ❌ Screened Out (${screenedOut.length})

Not South Asian or DMs closed.

### From API: ${apiScreened.length}
${apiScreened.map(s => `- @${s.handle}`).join('\n')}

### From IG Search: ${igScreened.length}
${igScreened.map(s => `- @${s.handle}`).join('\n')}

## 📅 Next Steps

1. **Feb 14**: Run \`node reachpilot.mjs followup\` to check for replies and send follow-ups
2. **Monitor**: Check Instagram DMs for responses
3. **Iterate**: Run \`igsearch\` again with new keywords or use different search terms

## 💡 Improvement Ideas

- Implement full reel-browsing in search results (not just dropdown)
- Try different search keywords to find more South Asian creators
- Test hashtag searches: #resumetips, #jobsearchindia, #careeradviceindia
`;

fs.writeFileSync('results-summary.md', summary);

// Write pending-followup.txt
const followupList = [...apiSent, ...igSearchSent].map(c => `@${c.handle}`).join('\n');
fs.writeFileSync('pending-followup.txt', `# Follow-up on Feb 14

Run: node reachpilot.mjs followup

Creators to check:
${followupList}
`);

console.log('✅ Created tracking files:');
console.log('   📄 sent-dms.csv (import to spreadsheet)');
console.log('   📄 results-summary.md (readable overview)');
console.log('   📄 pending-followup.txt (who needs follow-up)');
console.log('');
console.log(`📊 Quick Stats:`);
console.log(`   Total DMs: ${apiSent.length + igSearchSent.length}`);
console.log(`   API: ${apiSent.length} | IG Search: ${igSearchSent.length}`);
console.log(`   Screened Out: ${screenedOut.length}`);
