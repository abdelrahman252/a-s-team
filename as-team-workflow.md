# A's Team Dashboard — Full Workflow & Architecture

---

## What the App Does

Collects daily performance data for each team member by automating two systems:
- **Khod-Whaat** → order counts, delivery rates, collection amounts
- **TikTok Ads Manager** → ad spend per account

Then combines everything into a dashboard showing: Spend, Total Orders, CPA, Delivered Orders, Sum/Avg تحصيله, Avg Qty.

---

## Team Members

| Member | Khod-Whaat Login | TikTok Accounts |
|---|---|---|
| Abubakr | ✅ Email + Password | 3 accounts (all summed) |
| Abdelrahman | ✅ Email + Password | 1 account |
| Assem | ✅ Email + Password | 1 account |
| Ahmed Adel | ✅ Email + Password | 1 account |
| Ahmed Mo | ✅ Email + Password | 1 account |

---

## Step-by-Step Workflow

### Step 1 — User Selects Members + Date in the App

The user opens the Execution page, picks which members to run, and selects a date (Today / Single Date / Date Range). Clicks **Run Execution**.

---

### Step 2 — Bot Starts: Members Run One by One (Sequentially)

The bot runs each selected member **one at a time**, fully completing Phase 1 + Phase 2 before moving to the next person.

> Example: Abubakr finishes completely → then Abdelrahman starts → then Assem, etc.

---

### Step 3 — Phase 1: Khod-Whaat (per member)

**3.1 — Open Browser & Login**

- Opens a Chrome window with a **saved profile** for this member (`browser-profiles/khod-{id}`)
- Navigates to: `https://khod-whaat.com/affiliate/auth/login`
- If the session is already saved → skips login automatically ("Already logged in")
- If not logged in → auto-fills **email + password** from saved config → clicks submit → waits for redirect

**3.2 — All Orders Sheet**

- Navigates to: `https://khod-whaat.com/affiliate/orders/list/all`
- Opens the **flatpickr** date picker (`#from_date + input`)
- Clicks the FROM date → clicks the TO date
- Presses Escape to close
- Clicks `button[name="filter"]` → waits for page reload
- Clicks `button[name="export"]` → waits for Excel file to download
- Parses the downloaded sheet:
  - Filters rows where `تاريخ الإنشاء` (col 19) is within the selected date range
  - **Total Orders** = count of matching rows
  - **Avg Qty (Total)** = average of `عدد القطع` (col 14) across those rows

**3.3 — Delivered Orders Sheet**

- Navigates directly to: `https://khod-whaat.com/affiliate/orders/list/delivered`
  - *(No clicking on تم التوصيل — we go to the URL directly)*
- Same date filter → فلترة → export → download
- Parses the sheet:
  - Filters rows by `تاريخ الإنشاء` (col 19)
  - **Delivered Orders** = count of matching rows
  - **Sum المطلوب تحصيله** = sum of col 23
  - **Avg المطلوب تحصيله** = average of col 23
  - **Avg Qty (Delivered)** = average of `عدد القطع` (col 14)

**3.4 — Close Khod-Whaat Browser**

Chrome closes after Khod-Whaat is done for this member.

---

### Step 4 — Phase 2: TikTok Ads (per member)

**4.1 — Open Browser & Login**

- Opens a **separate** Chrome window with a saved profile for this member (`browser-profiles/tiktok-{id}`)
- Navigates to: `https://ads.tiktok.com/i18n/login`
- If already logged in (saved session) → skips login
- If not → waits up to **10 minutes** for the user to login manually in the browser window
  - *(TikTok login is always manual — no auto-fill)*

**4.2 — Scrape Each TikTok Account**

For each TikTok account URL saved for this member:
- Cleans the URL to keep only `?aadvid=xxx` (removes stale filter params)
- Navigates to the campaigns page
- Waits for the date picker to appear (confirms page loaded)
- Opens the TikTok date picker and sets the date range
- Reads spend from the table footer: `[slot="footer-stat_cost"] ks-text-91z`
- **If spend is 0 or missing → that's fine, treated as 0 and added to total**

**For Abubakr specifically:**
- Loops through all 3 accounts sequentially (no re-login between them, same session)
- `Total Spend = Account 1 + Account 2 + Account 3`
- Any account showing 0 spend doesn't cause an error — 0 is just added

**4.3 — Close TikTok Browser**

Chrome closes after TikTok is done for this member.

---

### Step 5 — Combine Results per Member

After both phases complete, the bot calculates:

```
CPA = Spend ÷ Total Orders   (if either is 0, CPA = 0)
```

Final result object per member:

| Field | Source |
|---|---|
| Spend | TikTok footer |
| Total Orders | Khod /all sheet row count |
| Avg Qty (Total) | Khod /all sheet col 14 avg |
| CPA | Spend ÷ Total Orders |
| Delivered Orders | Khod /delivered sheet row count |
| Avg Qty (Delivered) | Khod /delivered sheet col 14 avg |
| Sum المطلوب تحصيله | Khod /delivered sheet col 23 sum |
| Avg المطلوب تحصيله | Khod /delivered sheet col 23 avg |

---

### Step 6 — Next Member Starts

The bot moves to the next selected member and repeats Steps 3–5 from scratch.

---

### Step 7 — Dashboard Loads

Once all members are done, the app automatically navigates to the Dashboard page showing:
- **Single view**: 8 stat cards + trend chart for one member at a time
- **Team view**: Full table for all members + summary totals

---

## Why Does It Open a New Chrome Window per Phase?

**Short answer: each member's Khod account is a different login session, and each member's TikTok is also a different login session. They can't share one browser.**

Here's the full reasoning:

### The Session Problem

Khod-Whaat and TikTok both track who is logged in using browser cookies. If you have Abubakr logged into Khod-Whaat and you navigate to Abdelrahman's data, the site still shows Abubakr's orders — because the cookies say you're Abubakr.

To switch members, you either have to:
1. **Log out and log back in** (slow, and loses the session for next time)
2. **Use a separate browser profile** (each profile has its own cookies — fast, persistent)

### Persistent Profiles = Saved Sessions

Each member gets their own Chrome profile folder:
```
userData/browser-profiles/khod-abubakr/      ← Abubakr's khod cookies
userData/browser-profiles/khod-abdelrahman/  ← Abdelrahman's khod cookies
userData/browser-profiles/tiktok-abubakr/    ← Abubakr's TikTok cookies
...
```

This means **on the second run, the bot skips login entirely** for any member who was already logged in previously. The session is saved in the profile and stays valid for weeks.

### Why Not One Chrome Window for Everything?

If we used a single Chrome window:
- Logging into Khod as Abdelrahman would **kick out** Abubakr's session
- We'd have to log in and out 5 times per run for Khod, and 5 more times for TikTok
- A login failure for one person would potentially corrupt another person's session

With separate profiles, each member is completely isolated. Even if Abdelrahman's login fails, Abubakr's session is untouched.

### Why Khod and TikTok Are Also Separate?

They're different websites entirely. There's no reason to mix them in one window. Keeping them in separate profiles also means:
- Khod sessions persist independently of TikTok sessions
- If you clear one, the other is unaffected

### Can It Be One Window?

Technically yes — but only if we logged out and in between every member. That would:
- Be slower (full login every time vs. instant session reuse)
- Risk getting rate-limited or flagged for rapid login switching
- Mean TikTok (manual login) would require you to sit there and login 5 times per run

The current approach means **you only ever need to manually login once per member** (first run). After that it's fully automatic.

---

## File Structure

```
as-team-app/
├── package.json                    ← dependencies (electron, playwright, xlsx)
├── src/
│   ├── main/
│   │   ├── main.js                 ← Electron main process, IPC handlers, credential store
│   │   └── preload.js              ← exposes window.api to renderer (security bridge)
│   ├── bot/
│   │   ├── runner.js               ← orchestrates sequential member runs
│   │   ├── khod.js                 ← Khod-Whaat bot (login, flatpickr, export, parse)
│   │   └── tiktok.js               ← TikTok Ads bot (login, date picker, spend reader)
│   └── renderer/
│       ├── index.html              ← entire UI (setup, execution, running, dashboard)
│       └── styles/
│           └── main.css            ← all styles
```

---

## Sheet Column Reference

Both `/all` and `/delivered` exports have the same structure:

| Col Index | Column Name | Used For |
|---|---|---|
| 14 | عدد القطع | Avg Qty calculation |
| 19 | تاريخ الإنشاء | Date range filter |
| 23 | المطلوب تحصيله | Sum + Avg (delivered sheet only) |

---

## Key Selectors Reference

### Khod-Whaat
| Action | Selector |
|---|---|
| Login URL | `https://khod-whaat.com/affiliate/auth/login` |
| Email field | `input[name="email"]` |
| Password field | `input[name="password"]` |
| Submit button | `button[type="submit"]` |
| Open date picker | `#from_date + input` |
| Calendar open | `.flatpickr-calendar.open` |
| Click a day | `span.flatpickr-day[aria-label="April 26, 2026"]` |
| Prev month | `.flatpickr-prev-month` |
| Next month | `.flatpickr-next-month` |
| Filter button | `button[name="filter"]` |
| Export button | `button[name="export"]` |

### TikTok Ads
| Action | Selector |
|---|---|
| Login URL | `https://ads.tiktok.com/i18n/login` |
| Date picker trigger | `ks-date-time-picker-display-field-91z button` |
| Day cells | `.date-grid-body__date-item` |
| Confirm button | `ks-button-91z` with text "Confirm" (Shadow DOM) |
| Spend value | `[slot="footer-stat_cost"] ks-text-91z` |
