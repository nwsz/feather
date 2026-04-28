/**
 * Feather — background.js
 * Handles webhook dispatch, tab tracking, and Supabase logging.
 *
 * ── CONFIGURE THESE ──────────────────────────────────────────────────────────
 */
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/your_webhook_here";
const SUPABASE_URL        = "supabase_url";           // e.g. https://xxxx.supabase.co
const SUPABASE_ANON_KEY   = "supabase_anon_key";      // under the settings tab > api keys > anon public
const SUPABASE_TABLE      = "feather_logs";                     // table name in your DB

// FOR TABLE CREATION - PLEASE COPY THE TEXT WITHIN SETUP.MD SO THAT YOU KNOW EXACTLY WHAT TO PUT IN THERE
// ─────────────────────────────────────────────────────────────────────────────

// Track which tabs have the content script active
const discordTabs = new Set();

// Write integration status so popup can read it
chrome.storage.local.set({
  feather_integrations: {
    webhook:  DISCORD_WEBHOOK_URL !== "YOUR_DISCORD_WEBHOOK_URL_HERE",
    supabase: SUPABASE_URL        !== "YOUR_SUPABASE_URL_HERE"
  }
});

// ── Supabase insert ───────────────────────────────────────────────────────────
async function logToSupabase(entry) {
  if (!SUPABASE_URL || SUPABASE_URL === "YOUR_SUPABASE_URL_HERE") return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(entry)
    });
  } catch (err) {
    console.error('[Feather] Supabase log failed:', err);
  }
}

// ── Discord webhook ───────────────────────────────────────────────────────────
async function sendToDiscord(count, author, content, channel) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL === "YOUR_DISCORD_WEBHOOK_URL_HERE") return;
  try {
    const time = new Date().toLocaleTimeString();
    const authorLine  = author  ? `**Author:** ${author}\n`  : '';
    const channelLine = channel ? `**Channel:** ${channel}\n` : '';
    const contentLine = content ? `**Message:** ${content}\n` : '';

    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `@everyone **New Discord Message** · ${time}\n${authorLine}${channelLine}${contentLine}**Total count:** ${count}`
      }),
    });
  } catch (err) {
    console.error('[Feather] Webhook failed:', err);
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 1. Webhook + Supabase trigger from content script
  if (msg.type === 'SEND_WEBHOOK') {
    const { count, author, content, channel, timestamp } = msg;

    sendToDiscord(count, author, content, channel);

    logToSupabase({
      author:    author    || 'unknown',
      content:   content   || '',
      channel:   channel   || '',
      count,
      timestamp: timestamp || new Date().toISOString()
    });

    // Update recent messages log in storage (keep last 50)
    chrome.storage.local.get(['feather_recent'], (res) => {
      const recent = res.feather_recent || [];
      recent.unshift({ author, content, channel, timestamp: timestamp || new Date().toISOString() });
      if (recent.length > 50) recent.length = 50;
      chrome.storage.local.set({ feather_recent: recent });
    });

    sendResponse({ ok: true });
    return true;
  }

  // 2. Content script check-in (tab registration)
  if (msg.type === 'FEATHER_CHECKIN') {
    if (sender.tab && sender.tab.id) {
      discordTabs.add(sender.tab.id);
      chrome.storage.local.set({ feather_discord_open: true });
    }
    sendResponse({ ok: true });
    return true;
  }

  // 3. Relay popup commands → content scripts
  if (msg.target === 'content') {
    const relay = (tabId) => {
      chrome.tabs.sendMessage(tabId, msg, () => {
        void chrome.runtime.lastError;
      });
    };

    if (discordTabs.size > 0) {
      discordTabs.forEach(relay);
    } else {
      chrome.tabs.query({ url: 'https://discord.com/*' }, (tabs) => {
        tabs.forEach((tab) => relay(tab.id));
      });
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── Clean up closed tabs ──────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  discordTabs.delete(tabId);
  if (discordTabs.size === 0) {
    chrome.storage.local.set({ feather_discord_open: false });
  }
});
