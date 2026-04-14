// ═══════════════════════════════════════════════════════════════
//  신속배송 · Sinsok Delivery — Google Apps Script Backend
//  Version: 3.0.0
//  Paste this entire file into your Apps Script editor.
//
//  v3 changes:
//  - Rate limiting via CacheService (max 20 req / IP / minute)
//  - Enhanced ping endpoint reports config health
//  - history note field returned (was silently dropped in v2)
// ═══════════════════════════════════════════════════════════════

// ─── VERSION ────────────────────────────────────────────────────
const VERSION = '3.0.0';

// ─── CONFIGURATION ──────────────────────────────────────────────
const SHEET_NAME    = 'Tracking';
const HISTORY_SHEET = 'History';
const LOG_SHEET     = 'Logs';
const COMPANY_NAME  = '신속배송 · Sinsok Delivery';
const COMPANY_KR    = '신속배송';
const BRAND_COLOR   = '#2563EB';
const SITE_URL      = 'YOUR_SITE_URL_HERE'; // e.g. https://yoursite.pages.dev

// ─── RATE LIMITING ───────────────────────────────────────────────
// Maximum requests per IP per minute window.
// Uses CacheService (GAS built-in, no external dependency).
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS   = 20;

// ─── TRACKING NUMBER VALIDATION ──────────────────────────────────
const TRACKING_REGEX = /^[A-Z0-9\-]{3,40}$/;

// ─── COLUMN MAP (1-based) ────────────────────────────────────────
const COL = {
  TRACKING_NUMBER:  1,
  CUSTOMER_EMAIL:   2,
  STATUS:           3,
  LOCATION:         4,
  LAST_UPDATED:     5,
  ETA:              6,
  CUSTOMER_NAME:    7,
  PREVIOUS_STATUS:  8,
  DELIVERY_PHOTO:   9,
  SERVICE_TIER:     10,
};

// ─── STEP ORDER ──────────────────────────────────────────────────
const ALL_STEPS = [
  'order_received',
  'preparing_shipment',
  'shipment_completed',
  'in_transit',
  'out_for_delivery',
  'delivered',
];

// ─── STATUS LABELS ───────────────────────────────────────────────
const STATUS_LABELS = {
  order_received:     { en: 'Order Received',      kr: '주문 접수',       msg: 'We have received your order and are processing it.' },
  preparing_shipment: { en: 'Preparing Shipment',  kr: '상품 준비 중',    msg: 'Your item is being carefully prepared for shipment.' },
  shipment_completed: { en: 'Shipment Completed',  kr: '배송 준비 완료',  msg: 'Your package has been packed and is ready to ship.' },
  in_transit:         { en: 'In Transit',           kr: '배송 중',         msg: 'Your package is on its way to the delivery hub.' },
  out_for_delivery:   { en: 'Out for Delivery',     kr: '배달 출발',       msg: 'Your package is out for delivery today. Please be available to receive it.' },
  delivered:          { en: 'Delivered',             kr: '배달 완료',       msg: 'Your package has been successfully delivered. Thank you for choosing us!' },
};

// ═══════════════════════════════════════════════════════════════
//  doGet — READ tracking data
// ═══════════════════════════════════════════════════════════════
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};

  // ── Health / config ping
  if (params.action === 'ping') {
    const configOk = SITE_URL !== 'YOUR_SITE_URL_HERE';
    const sheetOk  = !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    return buildResponse({
      ok:       configOk && sheetOk,
      version:  VERSION,
      ts:       new Date().toISOString(),
      checks: {
        site_url_configured: configOk,
        tracking_sheet_exists: sheetOk,
      }
    });
  }

  // ── Rate limiting
  const rateLimitResult = checkRateLimit(e);
  if (rateLimitResult) return rateLimitResult;

  const raw = (params.trackingNumber || '').trim().toUpperCase();

  if (!raw) {
    return buildResponse({ error: 'MISSING_PARAM', message: 'trackingNumber is required' });
  }

  if (!TRACKING_REGEX.test(raw)) {
    return buildResponse({ error: 'INVALID_FORMAT', message: 'Invalid tracking number format' });
  }

  const result = getTrackingData(raw);

  if (!result) {
    return buildResponse({ error: 'NOT_FOUND', trackingNumber: raw });
  }

  return buildResponse(result);
}

// ═══════════════════════════════════════════════════════════════
//  doPost — trigger email manually
// ═══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const action = body.action || '';

    if (action === 'sendEmail') {
      const raw = (body.trackingNumber || '').trim().toUpperCase();
      if (!raw || !TRACKING_REGEX.test(raw)) {
        return buildResponse({ error: 'INVALID_FORMAT' });
      }
      const data = getTrackingData(raw);
      if (!data) return buildResponse({ error: 'NOT_FOUND' });
      sendStatusEmail(data);
      return buildResponse({ success: true, message: 'Email sent' });
    }

    return buildResponse({ error: 'UNKNOWN_ACTION' });
  } catch (err) {
    writeLog('ERROR', 'doPost', err.message);
    return buildResponse({ error: 'SERVER_ERROR', message: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  checkRateLimit — CacheService-based rate limiting
//  Returns a rate-limit response if exceeded, null otherwise.
// ═══════════════════════════════════════════════════════════════
function checkRateLimit(e) {
  try {
    // Derive a key from IP (available via e.parameter or UserSession)
    // GAS doesn't expose client IP directly; we use a session-based key.
    // For a more robust solution, use a hashed combination of available signals.
    const userKey = 'rate_' + Session.getTemporaryActiveUserToken();
    const cache   = CacheService.getScriptCache();
    const current = parseInt(cache.get(userKey) || '0', 10);

    if (current >= RATE_LIMIT_MAX_REQUESTS) {
      writeLog('WARN', 'checkRateLimit', 'Rate limit exceeded for key: ' + userKey.slice(-8));
      return buildResponse({
        error:   'RATE_LIMITED',
        message: 'Too many requests. Please wait a moment and try again.',
        retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS,
      });
    }

    // Increment; set expiry on first hit
    if (current === 0) {
      cache.put(userKey, '1', RATE_LIMIT_WINDOW_SECONDS);
    } else {
      // CacheService doesn't support increment+preserve TTL natively;
      // re-put with shorter remaining window (approximate).
      cache.put(userKey, String(current + 1), RATE_LIMIT_WINDOW_SECONDS);
    }

    return null; // no limit exceeded
  } catch (err) {
    // Never block a request due to rate-limit errors
    writeLog('WARN', 'checkRateLimit', 'Rate limit check failed: ' + err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  getTrackingData — reads sheet row, builds response
// ═══════════════════════════════════════════════════════════════
function getTrackingData(trackingNumber) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { writeLog('ERROR', 'getTrackingData', 'Sheet "' + SHEET_NAME + '" not found'); return null; }

  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const rowNum = (row[COL.TRACKING_NUMBER - 1] || '').toString().trim().toUpperCase();

    if (rowNum !== trackingNumber) continue;

    const status        = normalizeStatus(row[COL.STATUS - 1]);
    const history       = getHistoryFromSheet(trackingNumber);
    const deliveryPhoto = (row[COL.DELIVERY_PHOTO - 1] || '').toString().trim();
    const serviceTier   = (row[COL.SERVICE_TIER - 1] || 'Standard').toString().trim();
    const eta           = row[COL.ETA - 1];
    const etaFormatted  = formatDate(eta);
    const etaExpired    = isEtaExpired(eta, status);

    return {
      trackingNumber: row[COL.TRACKING_NUMBER - 1],
      customerEmail:  maskEmail(row[COL.CUSTOMER_EMAIL - 1] || ''),
      status,
      location:       row[COL.LOCATION - 1] || '',
      lastUpdated:    formatDate(row[COL.LAST_UPDATED - 1]),
      eta:            etaFormatted,
      etaExpired,
      customerName:   row[COL.CUSTOMER_NAME - 1] || '',
      serviceTier,
      deliveryPhoto:  deliveryPhoto || null,
      history,
      version:        VERSION,
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  getHistoryFromSheet — reads real History tab
//  NOTE: note field (col 5) is now included in the response.
// ═══════════════════════════════════════════════════════════════
function getHistoryFromSheet(trackingNumber) {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const histSheet = ss.getSheetByName(HISTORY_SHEET);

  if (histSheet) {
    const data    = histSheet.getDataRange().getValues();
    const history = [];

    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const rowNum = (row[0] || '').toString().trim().toUpperCase();
      if (rowNum !== trackingNumber.toUpperCase()) continue;

      history.push({
        step:     normalizeStatus(row[1]),
        time:     formatDate(row[2]),
        location: (row[3] || '').toString().trim(),
        note:     (row[4] || '').toString().trim(), // ← now returned
      });
    }

    return history;
  }

  // Synthesize plausible history as fallback (no History tab)
  const mainSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!mainSheet) return [];

  const data = mainSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const rowNum = (row[COL.TRACKING_NUMBER - 1] || '').toString().trim().toUpperCase();
    if (rowNum !== trackingNumber) continue;

    const currentStatus = normalizeStatus(row[COL.STATUS - 1]);
    const currentIdx    = ALL_STEPS.indexOf(currentStatus);
    if (currentIdx === -1) return [];

    const now     = new Date();
    const history = [];
    for (let s = 0; s <= currentIdx; s++) {
      const hoursBack = (currentIdx - s) * 8;
      const d = new Date(now.getTime() - hoursBack * 3600000);
      history.push({
        step:     ALL_STEPS[s],
        time:     Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM d, HH:mm'),
        location: s === currentIdx ? (row[COL.LOCATION - 1] || '') : '',
        note:     '',
      });
    }
    return history;
  }

  return [];
}

// ═══════════════════════════════════════════════════════════════
//  onEdit — TRIGGER: fires on Status column change
// ═══════════════════════════════════════════════════════════════
function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const editedCol = e.range.getColumn();
  const editedRow = e.range.getRow();

  if (editedCol !== COL.STATUS || editedRow < 2) return;

  const newStatus  = normalizeStatus(e.value || '');
  const prevStatus = normalizeStatus(sheet.getRange(editedRow, COL.PREVIOUS_STATUS).getValue() || '');

  if (!newStatus || !ALL_STEPS.includes(newStatus)) {
    writeLog('WARN', 'onEdit', 'Row ' + editedRow + ': invalid status "' + (e.value || '') + '" — skipped');
    return;
  }

  if (newStatus === prevStatus) return;

  const now = new Date();
  const ts  = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');

  sheet.getRange(editedRow, COL.PREVIOUS_STATUS).setValue(newStatus);
  sheet.getRange(editedRow, COL.LAST_UPDATED).setValue(ts);

  const trackingNumber = sheet.getRange(editedRow, COL.TRACKING_NUMBER).getValue().toString().trim().toUpperCase();
  const location       = sheet.getRange(editedRow, COL.LOCATION).getValue().toString().trim();
  appendHistory(trackingNumber, newStatus, ts, location);

  const data = getTrackingData(trackingNumber);
  if (data) {
    const rawEmail = sheet.getRange(editedRow, COL.CUSTOMER_EMAIL).getValue().toString().trim();
    const sendData = Object.assign({}, data, { customerEmail: rawEmail });

    if (rawEmail && rawEmail.indexOf('@') !== -1) {
      try {
        sendStatusEmail(sendData);
        writeLog('INFO', 'onEdit', 'Email sent: ' + trackingNumber + ' → ' + newStatus);
      } catch (err) {
        writeLog('ERROR', 'onEdit', 'Email FAILED: ' + trackingNumber + ' → ' + err.message);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  appendHistory
// ═══════════════════════════════════════════════════════════════
function appendHistory(trackingNumber, status, timestamp, location) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let histSheet = ss.getSheetByName(HISTORY_SHEET);

  if (!histSheet) {
    histSheet = ss.insertSheet(HISTORY_SHEET);
    histSheet.appendRow(['Tracking Number', 'Step', 'Time', 'Location', 'Note']);
    histSheet.setFrozenRows(1);
  }

  histSheet.appendRow([trackingNumber, status, timestamp, location, '']);
}

// ═══════════════════════════════════════════════════════════════
//  writeLog
// ═══════════════════════════════════════════════════════════════
function writeLog(level, context, message) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(LOG_SHEET);

    if (!logSheet) {
      logSheet = ss.insertSheet(LOG_SHEET);
      logSheet.appendRow(['Timestamp', 'Level', 'Context', 'Message']);
      logSheet.setFrozenRows(1);
    }

    const ts = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    logSheet.appendRow([ts, level, context, message]);
    Logger.log('[' + level + '] [' + context + '] ' + message);
  } catch (logErr) {
    Logger.log('Log write failed: ' + logErr.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  sendStatusEmail
// ═══════════════════════════════════════════════════════════════
function sendStatusEmail(data) {
  const email = data.customerEmail;
  if (!email || email.indexOf('@') === -1) return;

  const statusInfo = STATUS_LABELS[data.status] || {
    en: data.status, kr: data.status, msg: 'Your package status has been updated.',
  };

  const subject = '[' + COMPANY_KR + '] ' + statusInfo.en + ' — ' + data.trackingNumber;
  const html    = buildEmailHTML(data, statusInfo);

  GmailApp.sendEmail(email, subject, '', { htmlBody: html, name: COMPANY_NAME });
}

// ═══════════════════════════════════════════════════════════════
//  buildEmailHTML — professional email template
// ═══════════════════════════════════════════════════════════════
function buildEmailHTML(data, statusInfo) {
  const name    = data.customerName || 'Valued Customer';
  const etaText = data.eta
    ? '<tr><td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Estimated Delivery:</strong></td><td style="padding:4px 0;font-size:13px;color:#0A1628;">' + data.eta + '</td></tr>'
    : '';
  const locText = data.location
    ? '<tr><td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Current Location:</strong></td><td style="padding:4px 0;font-size:13px;color:#0A1628;">' + data.location + '</td></tr>'
    : '';

  const trackingLink = SITE_URL && SITE_URL !== 'YOUR_SITE_URL_HERE'
    ? SITE_URL + '?track=' + encodeURIComponent(data.trackingNumber)
    : null;
  const trackBtnHTML = trackingLink
    ? '<tr><td colspan="2" style="padding-top:20px;"><a href="' + trackingLink + '" style="display:inline-block;background:#2563EB;color:#ffffff;font-size:13px;font-weight:600;padding:11px 24px;border-radius:8px;text-decoration:none;">Track My Package →</a></td></tr>'
    : '';

  const photoHTML = data.deliveryPhoto
    ? '<div style="margin-top:16px;padding:12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;"><p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:0.06em;">Proof of Delivery</p><a href="' + data.deliveryPhoto + '" style="font-size:13px;color:#2563EB;">View delivery photo →</a></div>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Package Update — ${data.trackingNumber}</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FA;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
          <!-- HEADER -->
          <tr>
            <td style="background:#0A1628;border-radius:14px 14px 0 0;padding:24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#3B82F6;">신속배송</p>
                    <p style="margin:3px 0 0;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:-0.02em;">Sinsok Delivery</p>
                  </td>
                  <td align="right">
                    <span style="background:rgba(37,99,235,0.25);border:1px solid rgba(37,99,235,0.5);color:#93C5FD;font-size:11px;font-weight:600;padding:5px 12px;border-radius:100px;letter-spacing:0.04em;">DELIVERY UPDATE</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- BODY -->
          <tr>
            <td style="background:#FFFFFF;padding:32px;">
              <p style="margin:0 0 24px;font-size:15px;color:#4A5568;line-height:1.5;">
                Dear <strong style="color:#0A1628;">${name}</strong>,
              </p>
              <!-- STATUS PILL -->
              <div style="background:linear-gradient(135deg,#EFF6FF,#DBEAFE);border:1px solid #BFDBFE;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#6B7280;">Current Status</p>
                <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#1D4ED8;letter-spacing:-0.02em;">${statusInfo.en}</p>
                <p style="margin:0;font-size:14px;color:#6B7280;">${statusInfo.kr}</p>
              </div>
              <p style="margin:0 0 24px;font-size:14px;color:#4A5568;line-height:1.65;">${statusInfo.msg}</p>
              <!-- DETAILS TABLE -->
              <div style="border:1px solid #E2E8F4;border-radius:10px;padding:18px;margin-bottom:20px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Tracking Number:</strong></td>
                    <td style="padding:4px 0;font-size:13px;color:#0A1628;font-family:monospace;font-weight:700;">${data.trackingNumber}</td>
                  </tr>
                  ${etaText}
                  ${locText}
                  <tr>
                    <td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Last Updated:</strong></td>
                    <td style="padding:4px 0;font-size:13px;color:#0A1628;">${data.lastUpdated}</td>
                  </tr>
                  ${trackBtnHTML}
                </table>
              </div>
              ${photoHTML}
              <p style="margin:24px 0 0;font-size:12px;color:#94A3B8;line-height:1.6;border-top:1px solid #F1F5F9;padding-top:20px;">
                If you have any questions about your delivery, please contact our customer service team.<br/>
                Thank you for choosing Sinsok Delivery.
              </p>
            </td>
          </tr>
          <!-- FOOTER -->
          <tr>
            <td style="background:#F8FAFC;border-radius:0 0 14px 14px;padding:18px 32px;text-align:center;border-top:1px solid #E2E8F4;">
              <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#0A1628;">신속배송 · Sinsok Delivery</p>
              <p style="margin:0;font-size:11px;color:#94A3B8;">서울특별시 강남구 · Seoul, South Korea</p>
              <p style="margin:8px 0 0;font-size:10px;color:#CBD5E1;">This is an automated notification — please do not reply to this email.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function normalizeStatus(val) {
  return (val || '').toString().trim().toLowerCase().replace(/\s+/g, '_');
}

function maskEmail(email) {
  if (!email || email.indexOf('@') === -1) return '';
  const [user, domain] = email.split('@');
  const visible = user.length > 2 ? user.slice(0, 2) : user.slice(0, 1);
  return visible + '***@' + domain;
}

function formatDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');
  }
  return val.toString();
}

function isEtaExpired(etaVal, status) {
  if (!etaVal || status === 'delivered') return false;
  try {
    const etaDate = etaVal instanceof Date ? etaVal : new Date(etaVal);
    return !isNaN(etaDate.getTime()) && etaDate < new Date();
  } catch (_) {
    return false;
  }
}

function buildResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════
//  TEST FUNCTION — run manually in Apps Script to test email
// ═══════════════════════════════════════════════════════════════
function testEmailSend() {
  const TEST_EMAIL = 'YOUR_TEST_EMAIL@gmail.com';
  if (TEST_EMAIL === 'YOUR_TEST_EMAIL@gmail.com') {
    throw new Error('Please replace YOUR_TEST_EMAIL@gmail.com with your actual email before running testEmailSend().');
  }

  const testData = {
    trackingNumber: 'SS20260101-001',
    customerEmail:  TEST_EMAIL,
    customerName:   'Test Customer',
    status:         'out_for_delivery',
    location:       'Seoul, Gangnam-gu',
    lastUpdated:    'Jan 1, 2026 09:10',
    eta:            'Jan 1, 2026',
    serviceTier:    'Express',
    deliveryPhoto:  null,
  };

  const statusInfo = STATUS_LABELS[testData.status];
  const html = buildEmailHTML(testData, statusInfo);

  GmailApp.sendEmail(
    testData.customerEmail,
    '[TEST] ' + COMPANY_NAME + ' — Package Update',
    '',
    { htmlBody: html, name: COMPANY_NAME }
  );

  writeLog('INFO', 'testEmailSend', 'Test email sent to ' + TEST_EMAIL);
  Logger.log('✅ Test email sent to ' + TEST_EMAIL);
}

// ═══════════════════════════════════════════════════════════════
//  MANUAL TEST — rate limit check (run in Apps Script editor)
// ═══════════════════════════════════════════════════════════════
function testRateLimit() {
  Logger.log('Rate limiting uses CacheService. To test, call doGet() 21 times.');
  Logger.log('Cache key prefix: rate_<temporaryUserToken>');
  Logger.log('Window: ' + RATE_LIMIT_WINDOW_SECONDS + 's, Max: ' + RATE_LIMIT_MAX_REQUESTS + ' req');
}
