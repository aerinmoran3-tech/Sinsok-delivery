# 신속배송 · Sinsok Delivery — Full Setup Guide

Complete step-by-step instructions to go from zero to a live tracking system.

---

## What You'll Have After Setup

- A live tracking website (Cloudflare Pages or GitHub Pages — free)
- A Google Sheet as your admin panel
- Automatic email notifications on every status change
- A persistent event history log per shipment
- An error log so nothing fails silently

---

## STEP 1 — Push to GitHub

1. Create a free GitHub account at github.com if you don't have one
2. Create a new repository (e.g. `sinsok-delivery`) — set it to **Public**
3. Upload all files from this folder:
   - `index.html`
   - `README.md`
   - `docs/SETUP.md`
   - `docs/SHEET.md`

```bash
git init
git add .
git commit -m "Initial deploy"
git remote add origin https://github.com/YOUR_USERNAME/sinsok-delivery.git
git push -u origin main
```

---

## STEP 2 — Deploy to Cloudflare Pages (Recommended)

1. Go to **pages.cloudflare.com** and sign in (free account)
2. Click **Create a project → Connect to Git**
3. Select your GitHub repo
4. Build settings:
   - Framework preset: **None**
   - Build command: *(leave blank)*
   - Build output directory: `/`
5. Click **Save and Deploy**
6. Your site is live at `https://YOUR_PROJECT.pages.dev`
7. Optionally add a custom domain in Pages → Custom Domains

> **Alternative: GitHub Pages**
> Settings → Pages → Source: Deploy from branch → main → /(root) → Save
> Live at: `https://YOUR_USERNAME.github.io/sinsok-delivery`

---

## STEP 3 — Create Your Google Sheet

1. Go to **sheets.google.com** — create a new spreadsheet
2. Rename **Sheet1** to: **`Tracking`** (exact name, case-sensitive)
3. Add these headers in Row 1:

| A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|
| Tracking Number | Customer Email | Status | Location | Last Updated | ETA | Customer Name | Previous Status | Delivery Photo | Service Tier |

4. **Freeze Row 1**: View → Freeze → 1 row

### Add a Test Row (Row 2):

```
SS20260101-001 | YOUR_EMAIL@gmail.com | out_for_delivery | Seoul, Gangnam-gu | | Jan 6, 2026 | Test Customer | | | Express
```

> ⚠️ Column H (Previous Status) and Column E (Last Updated) will be auto-filled. Leave them blank.

---

## STEP 4 — Set Up Google Apps Script

1. In your Google Sheet: **Extensions → Apps Script**
2. Delete all existing code in the editor
3. Open `Code.gs` from this package — copy the entire contents
4. Paste into the Apps Script editor
5. At the top, set your site URL:
   ```javascript
   const SITE_URL = 'https://YOUR_PROJECT.pages.dev';
   ```
6. Click **Save** (Ctrl+S or Cmd+S)

### Valid Status Values for Column C:

| Type exactly | Displayed as |
|---|---|
| `order_received` | Order Received |
| `preparing_shipment` | Preparing Shipment |
| `shipment_completed` | Shipment Completed |
| `in_transit` | In Transit |
| `out_for_delivery` | Out for Delivery |
| `delivered` | Delivered |

---

## STEP 5 — Deploy as Web App

1. In Apps Script: **Deploy → New deployment**
2. Click ⚙️ next to "Type" → select **Web app**
3. Settings:
   - Description: `Sinsok Tracking API v2`
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**
5. Click **Authorize access** → choose your Google account → **Allow**
6. **Copy the Web App URL** — it looks like:
   ```
   https://script.google.com/macros/s/AKfycb.../exec
   ```
   Save this — you'll need it in the next step.

---

## STEP 6 — Connect Frontend to Backend

1. Open `index.html` in a text editor
2. Find these two lines near the top of the `<script>` section:
   ```javascript
   const GAS_URL       = 'YOUR_GAS_WEB_APP_URL_HERE';
   const USE_MOCK_DATA = true;
   ```
3. Replace with:
   ```javascript
   const GAS_URL       = 'https://script.google.com/macros/s/YOUR_ID/exec';
   const USE_MOCK_DATA = false;
   ```
4. Save the file and push to GitHub:
   ```bash
   git add index.html
   git commit -m "Connect to GAS backend"
   git push
   ```
5. Cloudflare Pages automatically redeploys within ~30 seconds.

---

## STEP 7 — Set Up the Auto-Email Trigger

The `onEdit` function fires automatically on manual sheet edits. To also register it formally:

1. In Apps Script: click the **clock icon** (Triggers) in the left sidebar
2. Click **+ Add Trigger**
3. Settings:
   - Function: `onEdit`
   - Deployment: `Head`
   - Event source: `From spreadsheet`
   - Event type: `On edit`
4. Click **Save** → authorize if prompted

---

## STEP 8 — Test Everything

### Test the API:
Visit this URL in your browser (replace with your actual URL and a real tracking number):
```
https://script.google.com/macros/s/YOUR_ID/exec?trackingNumber=SS20260101-001
```
You should see JSON with the tracking data.

### Test the email:
1. In Apps Script, find `testEmailSend()`
2. Change `YOUR_TEST_EMAIL@gmail.com` to your own email
3. Click **Run** (▶)
4. Check your inbox

### Test the full flow:
1. Open your live site
2. Search for the tracking number you added in Step 3
3. Change the Status in the sheet → check your email

---

## STEP 9 — Verify Auto-Created Tabs

After your first status change in the sheet, check that two new tabs appeared:

- **History** — one row per status change event, with timestamp and location
- **Logs** — INFO/WARN/ERROR entries for every script action

If email fails, the reason will be in the Logs tab.

---

## DAILY ADMIN WORKFLOW

To update a shipment:
1. Open your Google Sheet
2. Find the customer's row
3. Edit **Column C** (Status) — type the exact status value
4. Edit **Column D** (Location) if the package moved
5. Press Enter

The script automatically:
- Writes the timestamp to Column E
- Saves the old status to Column H
- Appends a row to the History tab
- Sends an email to the customer
- Logs the event to the Logs tab

---

## TROUBLESHOOTING

| Problem | Solution |
|---------|----------|
| "Package Not Found" for real data | Confirm `USE_MOCK_DATA = false` |
| Email not arriving | Check Logs tab for errors; re-authorize via Deploy → Manage |
| CORS error | Redeploy Web App with "Anyone" access |
| Status not refreshing in UI | Hard refresh: Ctrl+Shift+R |
| History tab not created | Make a status change — it auto-creates on first write |
| `onEdit` not firing | Add trigger manually: Apps Script → Triggers |
| API returns old data | GAS caches for ~1 min — wait or redeploy |

---

## IMPORTANT: Don't Rearrange Columns

The script maps data by column number (A=1, B=2, etc.). If you insert or delete a column, the script will read the wrong data and may send emails with incorrect information or write timestamps to the wrong cells.

If you need to add columns, **add them after Column J**.

---

*Version 2.0.0 — Built for South Korean logistics. Zero paid APIs. Zero external databases.*
