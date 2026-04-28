/**
 * Feather — content.js
 * Watches Discord for new messages using MutationObserver.
 * Features: deduplication (no double-counting own messages), author extraction,
 * channel detection, and full Supabase/webhook metadata.
 */

(function () {
  'use strict';

  let isEnabled    = true;
  let messageCount = 0;
  let observer     = null;
  let indicator    = null;
  let resetTimer   = null;

  // Track message IDs we've already counted to prevent duplicates
  const seenMessageIds = new Set();

  // ── Channel-switch suppression ────────────────────────────────────────────
  // When Discord navigates to a new channel it bulk-inserts historical messages.
  // We ignore all mutations for NAV_COOLDOWN ms after any navigation event.
  const NAV_COOLDOWN = 1500; // ms to ignore after a channel switch
  let navCooldownActive = false;
  let navCooldownTimer  = null;

  function triggerNavCooldown() {
    navCooldownActive = true;
    seenMessageIds.clear(); // old IDs irrelevant after channel change
    clearTimeout(navCooldownTimer);
    navCooldownTimer = setTimeout(() => {
      navCooldownActive = false;
    }, NAV_COOLDOWN);
  }

  // Intercept Discord's pushState / replaceState (it's a SPA, no real page loads)
  const _pushState    = history.pushState.bind(history);
  const _replaceState = history.replaceState.bind(history);
  history.pushState = function (...args) {
    triggerNavCooldown();
    return _pushState(...args);
  };
  history.replaceState = function (...args) {
    triggerNavCooldown();
    return _replaceState(...args);
  };
  window.addEventListener('popstate', triggerNavCooldown);

  // Suppress on initial page load too (first history dump)
  triggerNavCooldown();

  // ── Check in with background ──────────────────────────────────────────────
  chrome.runtime.sendMessage({ type: 'FEATHER_CHECKIN' }, () => {
    void chrome.runtime.lastError;
  });

  // ── Load persisted settings then boot ────────────────────────────────────
  chrome.storage.local.get(['feather_enabled', 'feather_count'], (result) => {
    isEnabled    = result.feather_enabled !== false;
    messageCount = result.feather_count   || 0;
    initIndicator();
    startObserver();
    updateIndicatorState();
  });

  // ── Listen for messages from popup ────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'FEATHER_TOGGLE') {
      isEnabled = msg.enabled;
      updateIndicatorState();
    }
    if (msg.type === 'FEATHER_RESET_COUNT') {
      messageCount = 0;
      seenMessageIds.clear();
      chrome.storage.local.set({ feather_count: 0 });
      setIndicatorWatching();
    }
  });

  // ── Helpers to extract Discord metadata ──────────────────────────────────

  /**
   * Extract a stable message ID from a DOM node.
   * Returns null if no ID can be found.
   */
  function getMessageId(node) {
    // Direct attribute
    const listId = node.getAttribute && node.getAttribute('data-list-item-id');
    if (listId && listId.startsWith('chat-messages-')) return listId;

    // Child with attribute
    const child = node.querySelector && node.querySelector('[data-list-item-id^="chat-messages-"]');
    if (child) return child.getAttribute('data-list-item-id');

    // data-message-id fallback
    const msgId = node.getAttribute && node.getAttribute('data-message-id');
    if (msgId) return `msg-${msgId}`;

    const msgChild = node.querySelector && node.querySelector('[data-message-id]');
    if (msgChild) return `msg-${msgChild.getAttribute('data-message-id')}`;

    return null;
  }

  /**
   * Extract author username from message node.
   * Discord renders author in [class*="username"] inside the message.
   */
  function getAuthor(node) {
    // Try the message node itself first, then nearest message container ancestor
    const searchRoot = node.closest
      ? (node.closest('[class*="message_"]') || node.closest('[class*="cozyMessage"]') || node)
      : node;

    const usernameEl =
      searchRoot.querySelector('[class*="username_"]') ||
      searchRoot.querySelector('[class*="headerText_"]') ||
      searchRoot.querySelector('[class*="clickableUsername"]');

    if (usernameEl) return usernameEl.textContent.trim();

    // Grouped messages don't repeat the username — walk up to find the header
    const msgList = searchRoot.closest('[class*="scroller_"]') || document;
    const allMessages = msgList.querySelectorAll('[data-list-item-id^="chat-messages-"]');
    for (const m of allMessages) {
      if (m === searchRoot || m.contains(searchRoot)) break;
      const u = m.querySelector('[class*="username_"]');
      if (u) {
        // This is the most recent header above our message in the group
        var lastAuthor = u.textContent.trim();
      }
    }
    return typeof lastAuthor !== 'undefined' ? lastAuthor : 'unknown';
  }

  /**
   * Extract message text content.
   */
  function getContent(node) {
    const contentEl =
      node.querySelector('[class*="messageContent_"]') ||
      node.querySelector('[class*="markup_"]');
    if (contentEl) {
      return contentEl.textContent.trim().slice(0, 200); // cap at 200 chars
    }
    return '';
  }

  /**
   * Get the current Discord channel name from the header.
   */
  function getChannel() {
    const headerEl =
      document.querySelector('h3[class*="title_"]') ||
      document.querySelector('[class*="channelName_"]') ||
      document.querySelector('h1[class*="title_"]');
    return headerEl ? headerEl.textContent.trim() : '';
  }

  // ── MutationObserver ──────────────────────────────────────────────────────

  function isNewMessageNode(node) {
    if (node.nodeType !== 1) return false;

    const listId = node.getAttribute('data-list-item-id') || '';
    if (listId.startsWith('chat-messages-')) return true;

    if (node.querySelector('[data-list-item-id^="chat-messages-"]')) return true;

    if (
      node.querySelector('[class*="messageContent_"]') ||
      node.querySelector('[class*="cozyMessage"]')
    ) return true;

    return false;
  }

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      if (!isEnabled || navCooldownActive) return;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length === 0) continue;
        for (const node of mutation.addedNodes) {
          if (!isNewMessageNode(node)) continue;

          // ── Deduplication ──────────────────────────────────────────────
          const msgId = getMessageId(node);

          // If we can get an ID, use it for dedup
          if (msgId) {
            if (seenMessageIds.has(msgId)) continue; // already counted
            seenMessageIds.add(msgId);
            // Keep set from growing unbounded
            if (seenMessageIds.size > 500) {
              const first = seenMessageIds.values().next().value;
              seenMessageIds.delete(first);
            }
          } else {
            // No ID: check if this node is a pending/nonce message (own message optimistic render)
            // Discord gives own messages a data-is-local-message="true" while pending
            const isLocal =
              node.getAttribute('data-is-local-message') === 'true' ||
              (node.querySelector && node.querySelector('[data-is-local-message="true"]'));
            if (isLocal) continue; // skip optimistic own-message render
          }

          // ── Extract metadata ───────────────────────────────────────────
          const author    = getAuthor(node);
          const content   = getContent(node);
          const channel   = getChannel();
          const timestamp = new Date().toISOString();

          messageCount++;
          chrome.storage.local.set({ feather_count: messageCount });
          triggerAlert(author, content, channel, timestamp);
          break;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Indicator ─────────────────────────────────────────────────────────────

  function initIndicator() {
    if (document.getElementById('feather-indicator')) return;

    indicator = document.createElement('div');
    indicator.id = 'feather-indicator';
    indicator.innerHTML = `
      <div class="feather-inner">
        <span class="feather-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5l6.74-6.76z" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            <line x1="16" y1="8" x2="2" y2="22" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
            <line x1="17.5" y1="15" x2="9" y2="15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="feather-label">watching</span>
      </div>
      <div class="feather-ripple"></div>
    `;
    document.body.appendChild(indicator);

    // Keyboard toggle: Alt+Q
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'q') {
        isEnabled = !isEnabled;
        chrome.storage.local.set({ feather_enabled: isEnabled });
        updateIndicatorState();
      }
    });
  }

  function updateIndicatorState() {
    if (!indicator) return;
    const label = indicator.querySelector('.feather-label');
    if (!isEnabled) {
      indicator.className = '';
      indicator.id = 'feather-indicator';
      indicator.classList.add('paused');
      label.textContent = 'paused';
    } else {
      setIndicatorWatching();
    }
  }

  function setIndicatorWatching() {
    if (!indicator) return;
    const label = indicator.querySelector('.feather-label');
    indicator.className = '';
    indicator.id = 'feather-indicator';
    indicator.classList.add('watching');
    label.textContent = messageCount > 0 ? `+${messageCount}` : 'watching';
  }

  function triggerAlert(author, content, channel, timestamp) {
    if (!indicator) return;
    const label  = indicator.querySelector('.feather-label');
    const ripple = indicator.querySelector('.feather-ripple');

    indicator.className = '';
    indicator.id = 'feather-indicator';
    indicator.classList.add('active');
    label.textContent = `+${messageCount}`;

    const newRipple = ripple.cloneNode(true);
    ripple.replaceWith(newRipple);

    chrome.runtime.sendMessage({
      type: 'SEND_WEBHOOK',
      count: messageCount,
      author,
      content,
      channel,
      timestamp
    });

    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      if (isEnabled) setIndicatorWatching();
    }, 3500);
  }

})();