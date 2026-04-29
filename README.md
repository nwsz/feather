# [Feather](https://nwsz.github.io/feather/docs)

> Whisper-light Discord message notifications — with Supabase logging and webhook alerts. Thanks to claude for the readme lol.
> Read the open source documentation at https://nwsz.github.io/feather/docs for indepth install and setup guides!

Feather is a free, local, Chrome extension that sits on top of Discord and detects new incoming messages in real time. It shows a minimal overlay indicator on the Discord page, pops up a clean dashboard with message history and stats, fires Discord webhook alerts with author and message preview, and logs everything to a Supabase database.  Useful for tracking messages sent in channels or servers that you cannot add bots to. It's also undetectable to any other user, so unless you tell them, they will never know you're using it to track them 🤫

---

## Table of Contents

- [Features](#features)
- [File Structure](#file-structure)
- [Installation](#installation)
- [Configuration](#configuration)
- [Supabase Setup](#supabase-setup)
- [How It Works](#how-it-works)
- [Popup UI](#popup-ui)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Message Detection Logic](#message-detection-logic)
- [Channel Switch Suppression](#channel-switch-suppression)
- [Chrome Storage Keys](#chrome-storage-keys)
- [Message Passing](#message-passing)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

---

## Features

- **Live overlay indicator** injected directly into the Discord page — shows `watching`, `+N`, or `paused` state with a ripple animation on new messages
- **Real-time message detection** via `MutationObserver` — no polling, no Discord API
- **Author extraction** — reads the sender's username from the DOM, including grouped messages where Discord hides the repeated header
- **Channel detection** — reads the active channel name from the Discord header
- **Message preview** — captures up to 200 characters of message content
- **Webhook alerts** — posts to a Discord webhook with author, channel, message preview, and running count
- **Supabase logging** — every detected message is inserted as a row in your database with full metadata
- **Deduplication** — tracks message IDs to prevent double-counting (Discord's optimistic rendering can add the same message twice)
- **Channel switch suppression** — two-layer defence prevents the historical message backfill from triggering false alerts when you navigate between channels
- **Popup dashboard** with three tabs: Overview, Log, and Settings
- **Recent message log** — last 50 detected messages stored locally, viewable in the popup
- **Session stats** — unique author count, channel name, total session count
- **JSON export** — download the full local log as a `.json` file
- **Keyboard toggle** — `Alt+Q` to pause/resume without opening the popup
- **Full reset** — wipe all stored data from the Settings tab

---

## File Structure

```
feather/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker — webhook, Supabase, tab tracking
├── content.js          # Injected into discord.com — MutationObserver, overlay
├── popup.html          # Popup markup and inline styles
├── popup.js            # Popup logic — tabs, live updates, controls
├── styles.css          # Overlay indicator styles (injected into Discord)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Installation

Feather is a private unpacked extension — it is not on the Chrome Web Store.

1. Download or clone all the files into a folder (e.g. `feather/`)
2. Add your icons to `feather/icons/` — you need `icon16.png`, `icon48.png`, and `icon128.png`
3. Open Chrome and navigate to `chrome://extensions`
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked**
6. Select the `feather/` folder
7. The Feather icon will appear in your Chrome toolbar

To update after editing any file: go to `chrome://extensions` and click the **↺ refresh** icon on the Feather card. Then reload any open Discord tabs.

---

## Configuration

All configuration lives at the top of `background.js`. Open the file and replace the placeholder values:

```js
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN";
const SUPABASE_URL        = "https://your-project-id.supabase.co";
const SUPABASE_ANON_KEY   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";
const SUPABASE_TABLE      = "feather_logs"; // change if you named your table differently
```

Both integrations are optional. If you leave a value as the placeholder string, that integration is silently skipped. The popup's Overview tab shows live green/grey dots indicating whether each integration is configured.

After editing `background.js`, reload the extension at `chrome://extensions`.

### Getting a Discord Webhook URL

1. Open Discord and go to any server/channel you control
2. Click the **gear icon** next to the channel name → **Integrations** → **Webhooks**
3. Click **New Webhook**, give it a name, and copy the URL
4. Paste it as `DISCORD_WEBHOOK_URL` in `background.js`

Each detected message sends a POST to this URL in the format:

```
🔔 New Discord Message · 14:32:07
Author: username
Channel: general
Message: the first 200 chars of the message...
Total count: 12
```

---

## Supabase Setup

### 1. Create a project

Go to [supabase.com](https://supabase.com), create a new project, and wait for it to provision (~1 minute).

### 2. Create the table

In **SQL Editor**, run this exactly:

```sql
create table feather_logs (
  id          bigint generated always as identity primary key,
  author      text,
  content     text,
  channel     text,
  count       integer,
  timestamp   timestamptz default now()
);

alter table feather_logs enable row level security;

create policy "Allow anon insert"
  on feather_logs for insert to anon
  with check (true);

create policy "Allow anon select"
  on feather_logs for select to anon
  using (true);
```

### 3. Get your credentials

Go to **Project Settings → API** and copy:

- **Project URL** — e.g. `https://abcdefgh.supabase.co`
- **anon / public key** — the `eyJ...` string under "Project API keys"

Paste both into `background.js` as shown in [Configuration](#configuration).

### 4. Verify

After reloading the extension and triggering a detection, go to **Table Editor → feather_logs** in Supabase. A new row should appear within a second.

### Useful queries

```sql
-- All messages newest first
select timestamp, author, channel, content
from feather_logs
order by timestamp desc;

-- Messages per author
select author, count(*) as total
from feather_logs
group by author
order by total desc;

-- Activity by channel
select channel, count(*) as total
from feather_logs
group by channel
order by total desc;

-- Messages in the last 24 hours
select * from feather_logs
where timestamp > now() - interval '24 hours'
order by timestamp desc;
```

---

## How It Works

Feather has three components that communicate via Chrome's message passing API.

### content.js — injected into discord.com

Runs inside the Discord tab. Responsibilities:

- Injects the overlay indicator `div` into the page
- Runs a `MutationObserver` on `document.body` watching for added DOM nodes
- Identifies message nodes using Discord's `data-list-item-id="chat-messages-*"` attribute
- Extracts author, content, and channel name from the DOM
- Deduplicates using a `Set` of seen message IDs
- Suppresses false triggers on channel navigation (see [Channel Switch Suppression](#channel-switch-suppression))
- Sends `SEND_WEBHOOK` messages to `background.js` with full metadata
- Listens for `FEATHER_TOGGLE` and `FEATHER_RESET_COUNT` commands from the popup

### background.js — service worker

Runs as a persistent background service worker. Responsibilities:

- Tracks which tabs have the content script active (`discordTabs` Set)
- Receives `SEND_WEBHOOK` from content scripts
- POSTs to the Discord webhook URL
- INSERTs a row into Supabase via the REST API
- Maintains the local `feather_recent` log in `chrome.storage.local` (last 50 entries)
- Relays popup commands to content scripts
- Cleans up `discordTabs` when tabs close

### popup.html / popup.js — extension popup

Opens when you click the toolbar icon. Responsibilities:

- Reads state from `chrome.storage.local` on open
- Listens for live storage changes to update counts and status in real time
- Sends toggle and reset commands via `chrome.runtime.sendMessage`
- Renders the recent message log
- Handles JSON export
- Manages the three-tab UI (Overview, Log, Settings)

---

## Popup UI

### Overview tab

| Element | Description |
|---|---|
| Status dot (header) | Green pulsing = live, grey = paused |
| Count number | Total messages detected this session. Turns green when > 0 |
| Active toggle | Enable or disable detection. Syncs to the overlay in real time |
| Clear button | Resets the count to 0 and clears dedup history |
| Session stat | Same as count number |
| Authors stat | Number of unique authors seen since last clear |
| Channel stat | Current channel name (or count if multiple seen) |
| Status badge | `live` or `paused` |
| Webhook badge | Green `configured` or grey `not set` |
| Database indicator | Green dot = Supabase connected, grey = not configured |
| Discord pill (footer) | Green dot = Discord tab detected, red = not found |

### Log tab

Shows the last 50 detected messages in reverse chronological order. Each entry displays:
- **Author** in green monospace
- **Channel** as a blue pill (prefixed with `#`)
- **Time** in `HH:MM` format
- **Message preview** (up to 200 characters)

Use **clear all** to wipe the local log. This does not affect Supabase.

### Settings tab

| Item | Description |
|---|---|
| Version | Current extension version |
| Scope | Always `all channels` |
| Keyboard toggle | `alt + q` |
| Webhook status | Whether `DISCORD_WEBHOOK_URL` is configured |
| Supabase status | Whether `SUPABASE_URL` is configured |
| Export log as JSON | Downloads `feather-export-{timestamp}.json` with all local log data |
| Full reset | Clears all `chrome.storage.local` data and resets the content script count |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt + Q` | Toggle detection on/off (works anywhere on discord.com) |

The shortcut works even when the popup is closed. State is persisted to `chrome.storage.local` immediately, so it survives tab reloads.

---

## Message Detection Logic

Discord is a React single-page app. It does not use traditional navigation — the entire interface updates via DOM mutations. Feather uses a `MutationObserver` watching `document.body` with `{ childList: true, subtree: true }`.

A DOM node is classified as a message if any of the following are true:

1. It has `data-list-item-id` starting with `chat-messages-` (Discord's primary message marker)
2. It contains a child with that attribute
3. It contains an element with a class matching `messageContent_` or `cozyMessage` (fallback for older Discord versions)

**Author extraction** works by finding `[class*="username_"]` within the message container. Discord uses grouped messages (where the username only appears on the first in a group), so if no username is found on the node itself, Feather walks backwards through the message list to find the most recent header above it.

**Deduplication** uses a `Set` of message IDs (`data-list-item-id` values). If an ID has already been counted, the node is skipped. Nodes with `data-is-local-message="true"` are also skipped — these are Discord's optimistic renders of your own outgoing messages before server confirmation.

The `seenMessageIds` set is capped at 500 entries (oldest removed first) to prevent unbounded memory growth.

---

## Channel Switch Suppression

When you switch channels in Discord, it bulk-inserts the last ~50 messages from that channel's history into the DOM all at once. Without suppression, every one of these would trigger a detection.

Feather uses two independent layers:

### Layer 1 — URL poller

A `setInterval` running every 150ms compares `location.href` to the last known URL. Any change immediately arms a 2000ms cooldown during which the `MutationObserver` callback exits early. This catches every navigation method Discord uses regardless of how it patches the browser history API.

### Layer 2 — Burst detector

If a single `MutationObserver` callback contains 3 or more message nodes, that is treated as a history load rather than live chat (real messages arrive one at a time). The burst is suppressed: all message IDs in the batch are registered as seen, and the cooldown is re-armed.

These two layers run independently. A channel switch that trickles in slowly is caught by the URL poller; a fast bulk insert is caught by the burst detector; a slow initial page load is caught by both.

The cooldown is also triggered once at script initialisation to suppress the very first history dump when Discord loads.

---

## Chrome Storage Keys

All state is stored in `chrome.storage.local`. Keys used:

| Key | Type | Description |
|---|---|---|
| `feather_enabled` | `boolean` | Whether detection is active. Defaults to `true` |
| `feather_count` | `number` | Running message count for the current session |
| `feather_discord_open` | `boolean` | Whether a Discord tab with the content script is active |
| `feather_recent` | `array` | Last 50 detected messages `{ author, content, channel, timestamp }` |
| `feather_integrations` | `object` | `{ webhook: boolean, supabase: boolean }` — set by background.js on startup |

---

## Message Passing

Internal communication uses `chrome.runtime.sendMessage` and `chrome.runtime.onMessage`.

| Message | Direction | Payload | Description |
|---|---|---|---|
| `FEATHER_CHECKIN` | content → background | — | Registers the tab ID so background can relay commands back |
| `SEND_WEBHOOK` | content → background | `{ count, author, content, channel, timestamp }` | Triggers webhook POST and Supabase insert |
| `FEATHER_TOGGLE` | popup → background → content | `{ enabled: boolean, target: 'content' }` | Pauses or resumes the observer |
| `FEATHER_RESET_COUNT` | popup → background → content | `{ target: 'content' }` | Resets count to 0 and clears dedup set |

Commands with `target: 'content'` are relayed by the background service worker to all registered Discord tabs.

---

## Troubleshooting

### The overlay doesn't appear on Discord

- Make sure the extension is enabled at `chrome://extensions`
- Hard reload the Discord tab (`Ctrl+Shift+R`)
- Check that the content script isn't blocked — open DevTools on the Discord tab (F12) and look for any Feather-related errors in the Console

### The popup toggle/reset buttons do nothing

- Open `chrome://extensions` → Feather → click **service worker** to open the background DevTools
- Check for errors in the Console tab
- Reload the extension and the Discord tab

### Webhook messages aren't sending

- Confirm `DISCORD_WEBHOOK_URL` in `background.js` is your actual URL (not the placeholder)
- Check that `manifest.json` includes `"https://discord.com/*"` in `host_permissions`
- Open the background service worker DevTools and look for `[Feather] Webhook failed:` errors

### Supabase rows aren't appearing

- Confirm `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set correctly in `background.js`
- Check that `manifest.json` includes `"https://*.supabase.co/*"` in `host_permissions`
- Make sure the `feather_logs` table exists and the RLS policies were created (see [Supabase Setup](#supabase-setup))
- Open the background service worker DevTools and look for `[Feather] Supabase log failed:` errors

### Channel switches are still triggering false detections

- Reload the extension at `chrome://extensions` and reload the Discord tab — the old content script may still be running
- If it persists in a very active channel, the burst limit of 3 may need increasing. In `content.js`, change `const BURST_LIMIT = 3` to `5`

### Double-counting messages

- This is prevented by the `seenMessageIds` dedup set. If you're seeing it, open the Discord tab's DevTools Console and check for Feather errors that might be causing the set to reset unexpectedly
- Make sure you're running the latest `content.js` — an earlier version did not have deduplication

---

## Known Limitations

- **No historical message access** — Feather only detects messages that arrive while the extension is active and the Discord tab is open. It does not read chat history.
- **DOM-dependent** — Discord periodically updates its class names. If a Discord update changes `username_*`, `messageContent_*`, or `data-list-item-id` attributes, author/content extraction may degrade. The count itself is more robust as it relies on `data-list-item-id` which is structural.
- **Single tab** — if you have Discord open in multiple tabs, each tab runs an independent content script with its own count. The background service worker broadcasts commands to all registered tabs.
- **Service worker sleep** — Chrome's MV3 service workers can be suspended after inactivity. The background script will restart when a new message triggers it, but there may be a brief delay on the first event after a long idle period.
- **Supabase anon key** — the anon key is embedded in the extension source. Since this is a private extension that is never published, this is acceptable. Do not publish the extension or share the source with the key still in it.
https://nwsz.github.io/feather/docs :)
