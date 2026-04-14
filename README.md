# 신속배송 · Sinsok Delivery

> Real-time package tracking system powered by Google Sheets + Apps Script.  
> A single `index.html` frontend + one `Code.gs` backend. No servers, no databases, no monthly fees.

---

## Quick Deploy (5 Steps)

### 1 — Fork & Host on GitHub Pages

```bash
git clone https://github.com/YOUR_USERNAME/sinsok-delivery
cd sinsok-delivery
# Upload to GitHub, then enable Pages: Settings → Pages → main branch → /root
```

Or deploy to **Cloudflare Pages** (recommended — faster, free custom domains):

```
1. Go to pages.cloudflare.com
2. Connect your GitHub repo
3. Build settings: Framework = None, Build command = (empty), Output = /
4. Deploy — live in ~30 seconds
```

### 2 — Create Google Sheet

Create a spreadsheet at sheets.google.com with a tab named **`Tracking`** and these exact headers in Row 1:

| A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|
| Tracking Number | Customer Email | Status | Location | Last Updated | ETA | Customer Name | Previous Status | Delivery Photo | Service Tier |

> ⚠️ **Do not insert, delete, or reorder columns.** The script maps by column position.

### 3 — Deploy the Apps Script Backend

1. In your Sheet: **Extensions → Apps Script**
2. Delete all existing code
3. Paste the entire contents of `Code.gs`
4. Set `SITE_URL` at the top to your live site URL (e.g. `https://yoursite.pages.dev`)
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the Web App URL

### 4 — Connect Frontend to Backend

Open `index.html` and update these two lines near the top of the `<script>` block:

```javascript
const GAS_URL       = 'https://script.google.com/macros/s/YOUR_ID/exec';
const USE_MOCK_DATA = false;
```

Push to GitHub — Cloudflare auto-deploys within seconds.

### 5 — Test

Run `testEmailSend()` in Apps Script (update the email first), then track a real number on your site.

---

## File Structure

```
sinsok-delivery/
├── index.html       ← Complete frontend (single file, zero dependencies)
├── Code.gs          ← Google Apps Script backend (paste into Apps Script editor)
├── docs/
│   ├── SETUP.md     ← Full setup guide
│   └── SHEET.md     ← Google Sheet column reference
└── README.md        ← This file
```

---

## Google Sheet Reference

### Tracking Tab (required)

| Column | Header | Values |
|--------|--------|--------|
| A | Tracking Number | Any format, e.g. `SS20260101-001` |
| B | Customer Email | Full email — masked in API, used for notifications |
| C | Status | See status values below |
| D | Location | Free text, e.g. `Seoul, Gangnam-gu` |
| E | Last Updated | Auto-filled by script on status change |
| F | ETA | Date string or Date cell |
| G | Customer Name | Used in email greeting |
| H | Previous Status | **Script-managed — do not edit** |
| I | Delivery Photo | URL to proof-of-delivery image (optional) |
| J | Service Tier | `Express` / `Standard` / `Economy` (optional) |

### Valid Status Values

| Type in Column C | Displays As |
|---|---|
| `order_received` | Order Received |
| `preparing_shipment` | Preparing Shipment |
| `shipment_completed` | Shipment Completed |
| `in_transit` | In Transit |
| `out_for_delivery` | Out for Delivery |
| `delivered` | Delivered |

### History Tab (auto-created)

The script creates this tab automatically. Columns: `Tracking Number`, `Step`, `Time`, `Location`, `Note`

Every time you change a status in the Tracking tab, a new row is appended here — building a real event log.

### Logs Tab (auto-created)

The script creates this tab automatically. Columns: `Timestamp`, `Level`, `Context`, `Message`

Check here for email failures, script errors, and status change events.

---

## Daily Admin Workflow

1. Open your Google Sheet
2. Find the customer row
3. Change **Column C** (Status) to the new status value
4. Optionally update **Column D** (Location)
5. Hit Enter — the script automatically:
   - Updates the timestamp (Column E)
   - Writes to the History tab
   - Sends a notification email
   - Logs the event

---

## Customization

### Brand name
Search for `Sinsok` in both files and replace with your brand name.

### Colors
Edit CSS variables at the top of `index.html`:
```css
--accent: #2563EB;   /* Main brand color */
--green:  #10B981;   /* Delivered/success color */
```

### Add languages
Add a new key to the `STRINGS` object in `index.html` and add a language button to the header.

### Tracking number format
Any alphanumeric + hyphen format works, up to 40 characters.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Package Not Found" for real data | Set `USE_MOCK_DATA = false` and redeploy |
| Email not sending | Re-authorize: Apps Script → Deploy → Manage deployments |
| Status badge stays unchanged | Hard refresh (Ctrl+Shift+R / Cmd+Shift+R) |
| `onEdit` not firing | Apps Script → Triggers → Add: `onEdit`, From spreadsheet, On edit |
| Email failures visible | Check the **Logs** tab in your spreadsheet |
| History not building | History tab is auto-created on first status change |

---

## Version

`2.0.0` — See `Code.gs` `VERSION` constant.

---

*Built for South Korean logistics. Zero paid APIs. Zero external databases. Just Google Sheets.*
