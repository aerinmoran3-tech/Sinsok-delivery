# Google Sheet Column Reference

Quick reference for the **Tracking** tab.

---

## Column Map

| Col | Header | Who fills it | Notes |
|-----|--------|--------------|-------|
| A | Tracking Number | You | Any format: `SS20260101-001`. Max 40 chars, letters/numbers/hyphens only. |
| B | Customer Email | You | Full email. Never exposed in API — masked to `ki***@example.com` |
| C | Status | You | Must match exact values below |
| D | Location | You | Free text. E.g. `Seoul, Gangnam-gu` |
| E | Last Updated | Script (auto) | Do not edit — overwritten on every status change |
| F | ETA | You | Date string or Date cell. E.g. `Jan 6, 2026` |
| G | Customer Name | You | Used in email greeting |
| H | Previous Status | Script (auto) | Do not edit — used to detect changes and avoid duplicate emails |
| I | Delivery Photo | You | URL to a photo (optional). Shown as "Proof of Delivery" on site |
| J | Service Tier | You | `Express`, `Standard`, or `Economy` (optional). Shown on tracking page |

---

## Valid Status Values

Type these **exactly** in Column C:

| Value | Display |
|-------|---------|
| `order_received` | Order Received / 주문 접수 |
| `preparing_shipment` | Preparing Shipment / 상품 준비 중 |
| `shipment_completed` | Shipment Completed / 배송 준비 완료 |
| `in_transit` | In Transit / 배송 중 |
| `out_for_delivery` | Out for Delivery / 배달 출발 |
| `delivered` | Delivered / 배달 완료 |

---

## Auto-Created Tabs

### History
Created automatically on first status change.

| A | B | C | D | E |
|---|---|---|---|---|
| Tracking Number | Step | Time | Location | Note |

One row is appended every time a status changes. This is what powers the real timeline on the tracking page.

### Logs
Created automatically on first script run.

| A | B | C | D |
|---|---|---|---|
| Timestamp | Level | Context | Message |

Check here if emails aren't sending or something behaves unexpectedly.

---

## Sample Row

```
SS20260101-001 | kim@example.com | out_for_delivery | Seoul, Gangnam-gu | (auto) | Jan 6, 2026 | Kim Jisoo | (auto) | https://... | Express
```
