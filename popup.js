/**
 * Feather — popup.js
 * Drives the popup UI: tabs, live log, stats, toggle, reset, export.
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const countEl          = document.getElementById('countNumber');
  const toggleEl         = document.getElementById('toggleInput');
  const resetBtn         = document.getElementById('resetBtn');
  const statusDot        = document.getElementById('statusDot');
  const statusText       = document.getElementById('statusText');
  const noTabBanner      = document.getElementById('noTabBanner');
  const discordDot       = document.getElementById('discordDot');
  const discordTabTxt    = document.getElementById('discordTabText');
  const statusBadge      = document.getElementById('statusBadge');
  const webhookBadge     = document.getElementById('webhookBadge');
  const dbDot            = document.getElementById('dbDot');
  const dbLabel          = document.getElementById('dbLabel');
  const statSession      = document.getElementById('statSession');
  const statAuthors      = document.getElementById('statAuthors');
  const statChannel      = document.getElementById('statChannel');
  const logList          = document.getElementById('logList');
  const logClearBtn      = document.getElementById('logClearBtn');
  const exportBtn        = document.getElementById('exportBtn');
  const fullResetBtn     = document.getElementById('fullResetBtn');
  const settingsWh       = document.getElementById('settingsWebhookStatus');
  const settingsDb       = document.getElementById('settingsDbStatus');

  let currentCount = 0;

  // ── Tabs ──────────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'log') renderLog();
    });
  });

  // ── Load state ────────────────────────────────────────────────────────────
  chrome.storage.local.get(
    ['feather_enabled', 'feather_count', 'feather_discord_open', 'feather_recent'],
    (result) => {
      const enabled = result.feather_enabled !== false;
      const count   = result.feather_count   || 0;
      const open    = result.feather_discord_open === true;

      toggleEl.checked = enabled;
      setCount(count);
      updateStatus(enabled);
      setDiscordStatus(open);
      updateStats(result.feather_recent || []);
      checkIntegrations();
    }
  );

  // ── Direct tab check ──────────────────────────────────────────────────────
  chrome.tabs.query({ url: ['https://discord.com/*', 'https://*.discord.com/*'] }, (tabs) => {
    const found = tabs.length > 0;
    setDiscordStatus(found);
    chrome.storage.local.set({ feather_discord_open: found });
  });

  // ── Live storage updates ──────────────────────────────────────────────────
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.feather_count !== undefined) {
      setCount(changes.feather_count.newValue || 0, true);
    }
    if (changes.feather_enabled !== undefined) {
      const en = changes.feather_enabled.newValue;
      toggleEl.checked = en;
      updateStatus(en);
    }
    if (changes.feather_discord_open !== undefined) {
      setDiscordStatus(changes.feather_discord_open.newValue);
    }
    if (changes.feather_recent !== undefined) {
      updateStats(changes.feather_recent.newValue || []);
      // Re-render log if it's visible
      if (document.getElementById('tab-log').classList.contains('active')) {
        renderLog();
      }
    }
  });

  // ── Toggle ────────────────────────────────────────────────────────────────
  toggleEl.addEventListener('change', () => {
    const enabled = toggleEl.checked;
    chrome.storage.local.set({ feather_enabled: enabled });
    updateStatus(enabled);
    chrome.runtime.sendMessage({ type: 'FEATHER_TOGGLE', enabled, target: 'content' });
  });

  // ── Reset count ───────────────────────────────────────────────────────────
  resetBtn.addEventListener('click', () => {
    setCount(0);
    chrome.storage.local.set({ feather_count: 0 });
    chrome.runtime.sendMessage({ type: 'FEATHER_RESET_COUNT', target: 'content' });
  });

  // ── Clear log ─────────────────────────────────────────────────────────────
  logClearBtn.addEventListener('click', () => {
    chrome.storage.local.set({ feather_recent: [] });
    renderLog([]);
    updateStats([]);
  });

  // ── Full reset ────────────────────────────────────────────────────────────
  fullResetBtn.addEventListener('click', () => {
    if (!confirm('Reset all Feather data?')) return;
    chrome.storage.local.clear(() => {
      setCount(0);
      updateStatus(true);
      toggleEl.checked = true;
      renderLog([]);
      updateStats([]);
    });
    chrome.runtime.sendMessage({ type: 'FEATHER_RESET_COUNT', target: 'content' });
  });

  // ── Export JSON ───────────────────────────────────────────────────────────
  exportBtn.addEventListener('click', () => {
    chrome.storage.local.get(['feather_recent', 'feather_count'], (res) => {
      const data = {
        exported_at: new Date().toISOString(),
        total_count: res.feather_count || 0,
        messages: res.feather_recent || []
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `feather-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function setCount(n, animate = false) {
    currentCount = n;
    countEl.textContent = n;
    countEl.classList.toggle('has-messages', n > 0);
    statSession.textContent = n;
    if (animate && n > 0) {
      countEl.classList.add('bump');
      setTimeout(() => countEl.classList.remove('bump'), 350);
    }
  }

  function updateStatus(enabled) {
    statusDot.className    = 'status-dot ' + (enabled ? 'live' : 'paused');
    statusText.textContent = enabled ? 'live' : 'paused';
    statusBadge.textContent = enabled ? 'live' : 'paused';
    statusBadge.className  = 'info-val ' + (enabled ? 'green' : '');
  }

  function setDiscordStatus(open) {
    if (open) {
      noTabBanner.classList.remove('visible');
      discordDot.classList.add('connected');
      discordTabTxt.textContent = 'discord.com';
    } else {
      noTabBanner.classList.add('visible');
      discordDot.classList.remove('connected');
      discordTabTxt.textContent = 'not found';
    }
  }

  function updateStats(recent) {
    const authors  = new Set(recent.map(m => m.author).filter(Boolean));
    const channels = new Set(recent.map(m => m.channel).filter(Boolean));

    statAuthors.textContent = authors.size  || '—';
    statChannel.textContent = channels.size === 1
      ? [...channels][0].slice(0, 6)
      : channels.size > 1 ? channels.size + ' ch' : '—';
  }

  function renderLog(items) {
    if (items) {
      _renderItems(items);
      return;
    }
    chrome.storage.local.get(['feather_recent'], (res) => {
      _renderItems(res.feather_recent || []);
    });
  }

  function _renderItems(items) {
    if (!items.length) {
      logList.innerHTML = '<div class="log-empty">No messages yet.</div>';
      return;
    }
    logList.innerHTML = items.map((m) => {
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const author  = m.author  || 'unknown';
      const channel = m.channel ? '#' + m.channel : '';
      const content = m.content || '';
      return `
        <div class="log-item">
          <div class="log-item-header">
            <span class="log-author">${escHtml(author)}</span>
            <div class="log-meta">
              ${channel ? `<span class="log-channel">${escHtml(channel)}</span>` : ''}
              <span class="log-time">${escHtml(time)}</span>
            </div>
          </div>
          ${content ? `<div class="log-content">${escHtml(content)}</div>` : ''}
        </div>
      `;
    }).join('');
  }

  function checkIntegrations() {
    // Ask background.js to report its config (we read it from the script itself via storage hint)
    // Since we can't read background.js constants directly, we use a convention:
    // background.js sets feather_integrations in storage on first run
    chrome.storage.local.get(['feather_integrations'], (res) => {
      const intg = res.feather_integrations || {};
      const whOk = intg.webhook;
      const dbOk = intg.supabase;

      webhookBadge.textContent = whOk ? 'configured' : 'not set';
      webhookBadge.className   = 'info-val ' + (whOk ? 'green' : '');

      dbDot.className  = 'db-dot ' + (dbOk ? 'ok' : '');
      dbLabel.textContent = dbOk ? 'connected' : 'not configured';

      settingsWh.textContent = whOk ? 'active' : 'not set';
      settingsDb.textContent = dbOk ? 'active' : 'not set';
    });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

})();
