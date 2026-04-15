// ═══════════════════════════════════════════════════════════════
// 신속배송 · Sinsok Delivery — Google Apps Script Backend
// Version: 3.1.0-fixed
//
// v3.1 fixes (original):
// - [#3] Admin actions (createOrder, updateStatus, lookupOrder)
//        moved to doPost — key no longer exposed in URL/logs
// - [#4] escapeHtml() helper added; all customer-supplied fields
//        sanitized before insertion into email HTML templates
// - [#6] handleUpdateStatus now saves the OLD status to
//        PREVIOUS_STATUS before overwriting STATUS
// - [#7] getSpreadsheet() called once per request; ss passed
//        as argument to avoid repeated Property lookups
// - [#8] Tracking lookup scans only the tracking-number column
//        first to find the row, then reads just that row
// - [#9] Rate-limit window is now fixed (stores window start
//        time + count together so TTL doesn't slide)
// - [#10] buildConfirmationEmailHTML also uses escapeHtml()
// - [#11] Stricter TRACKING_REGEX matches generated SS format
// - [#12] Test functions guarded; won't run on web-app entry
// - [#13] formatDate() wrapped in try/catch with '' fallback
// - [#14] Admin param strings capped at safe max lengths
//
// Additional fixes applied in this build:
// - [FIX-A] ADMIN_KEY fallback string was truncated (SyntaxError line 26)
// - [FIX-B] appendHistory() now accepts ss param to match [#7] pattern
// - [FIX-C] writeLog() now accepts optional ss param to reduce extra opens
// - [FIX-D] onEdit passes ss to appendHistory and writeLog
// - [FIX-E] sendEmail POST action now rate-limited (was unguarded public endpoint)
// - [FIX-F] buildConfirmationEmailHTML safeLoc ternary was truncated / unclosed
// ═══════════════════════════════════════════════════════════════

// ─── VERSION ────────────────────────────────────────────────────
const VERSION = '3.1.0-fixed';

// ─── ADMIN KEY ───────────────────────────────────────────────────
// Store via: Project Settings → Script Properties → ADMIN_KEY
// Must match the value set in admin.html.
// [FIX-A] Fallback string was truncated in original, causing SyntaxError.
const ADMIN_KEY = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY') || 'sinsok2026';

// ─── CONFIGURATION ──────────────────────────────────────────────
const SPREADSHEET_NAME = 'Sinsok Delivery';
const SHEET_NAME       = 'Tracking';
const HISTORY_SHEET    = 'History';
const LOG_SHEET        = 'Logs';
const COMPANY_NAME     = '신속배송 · Sinsok Delivery';
const COMPANY_KR       = '신속배송';
const BRAND_COLOR      = '#2563EB';
const SITE_URL         = 'https://sinsokdelivery.netlify.app';

// ─── RATE LIMITING ───────────────────────────────────────────────
// Fixed-window rate limiting via CacheService.
// Stores { count, windowStart } together so the TTL cannot slide.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS   = 20;

// ─── TRACKING NUMBER VALIDATION ──────────────────────────────────
// [#11] Matches the generated format exactly: SS + 8 digits + '-' + 3+ digits
// e.g. SS20260101-001 — also accepts legacy uppercase alphanumeric (3-40 chars)
const TRACKING_REGEX        = /^[A-Z0-9\-]{3,40}$/;
const TRACKING_REGEX_STRICT = /^SS\d{8}-\d{3,6}$/; // preferred for new orders

// ─── PARAM LENGTH CAPS [#14] ────────────────────────────────────
const MAX = {
  NAME:     100,
  EMAIL:    254,
  LOCATION: 200,
  NOTE:     500,
  CONTENTS: 300,
  TIER:      50,
  ETA:       30,
};

// ─── COLUMN MAP (1-based) ────────────────────────────────────────
const COL = {
  TRACKING_NUMBER: 1,
  CUSTOMER_EMAIL:  2,
  STATUS:          3,
  LOCATION:        4,
  LAST_UPDATED:    5,
  ETA:             6,
  CUSTOMER_NAME:   7,
  PREVIOUS_STATUS: 8,
  DELIVERY_PHOTO:  9,
  SERVICE_TIER:    10,
  PACKAGE_CONTENTS:11,
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
  order_received:      { en: 'Order Received',       kr: '주문 접수',       msg: 'We have received your order and it is now being processed.' },
  preparing_shipment:  { en: 'Preparing Shipment',   kr: '상품 준비 중',    msg: 'Your item is being carefully prepared and packed for shipment.' },
  shipment_completed:  { en: 'Shipment Completed',   kr: '배송 준비 완료',  msg: 'Your package has been packed and is ready for pickup by our courier.' },
  in_transit:          { en: 'In Transit',            kr: '배송 중',        msg: 'Your package is on its way to the destination.' },
  out_for_delivery:    { en: 'Out for Delivery',      kr: '배달 출발',      msg: 'Your package is out for delivery and will arrive today.' },
  delivered:           { en: 'Delivered',             kr: '배달 완료',      msg: 'Your package has been delivered. Thank you for choosing Sinsok Delivery!' },
};

// ═══════════════════════════════════════════════════════════════
// escapeHtml [#4, #10]
// Sanitizes any customer-supplied string before HTML insertion.
// ═══════════════════════════════════════════════════════════════
function escapeHtml(str) {
  return (str || '').toString()
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// ═══════════════════════════════════════════════════════════════
// cap — truncate a string to a safe maximum length [#14]
// ═══════════════════════════════════════════════════════════════
function cap(str, maxLen) {
  return (str || '').toString().trim().slice(0, maxLen);
}

// ═══════════════════════════════════════════════════════════════
// getSpreadsheet — auto-discovers, creates, and caches the sheet
// ═══════════════════════════════════════════════════════════════
function getSpreadsheet() {
  const props    = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty('_SS_ID');
  if (cachedId) {
    try { return SpreadsheetApp.openById(cachedId); } catch (e) { props.deleteProperty('_SS_ID'); }
  }
  try {
    const bound = SpreadsheetApp.getActiveSpreadsheet();
    if (bound) {
      initSpreadsheet(bound);
      props.setProperty('_SS_ID', bound.getId());
      return bound;
    }
  } catch (e) {}
  const files = DriveApp.getFilesByName(SPREADSHEET_NAME);
  if (files.hasNext()) {
    const id = files.next().getId();
    const ss = SpreadsheetApp.openById(id);
    initSpreadsheet(ss);
    props.setProperty('_SS_ID', id);
    return ss;
  }
  const ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  initSpreadsheet(ss);
  props.setProperty('_SS_ID', ss.getId());
  Logger.log('[INFO] [getSpreadsheet] Created new spreadsheet: ' + ss.getId());
  return ss;
}

// ═══════════════════════════════════════════════════════════════
// initSpreadsheet
// ═══════════════════════════════════════════════════════════════
function initSpreadsheet(ss) {
  _initTrackingSheet(ss);
  _initHistorySheet(ss);
  _initLogsSheet(ss);
}

function _initTrackingSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    const defaultSheet = ss.getSheets()[0];
    if (defaultSheet && defaultSheet.getName() === 'Sheet1') {
      sheet = defaultSheet;
      sheet.setName(SHEET_NAME);
    } else {
      sheet = ss.insertSheet(SHEET_NAME);
    }
  }
  if (sheet.getRange('A1').getValue() === '') {
    const headers = [
      'Tracking Number', 'Customer Email', 'Status', 'Location',
      'Last Updated', 'ETA', 'Customer Name', 'Previous Status',
      'Delivery Photo', 'Service Tier', 'Package Contents',
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#0A1628').setFontColor('#FFFFFF')
               .setFontWeight('bold').setFontSize(11);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1,  180);
    sheet.setColumnWidth(2,  200);
    sheet.setColumnWidth(3,  160);
    sheet.setColumnWidth(4,  180);
    sheet.setColumnWidth(5,  150);
    sheet.setColumnWidth(6,  120);
    sheet.setColumnWidth(7,  150);
    sheet.setColumnWidth(8,  160);
    sheet.setColumnWidth(9,  220);
    sheet.setColumnWidth(10, 120);
    sheet.setColumnWidth(11, 200);
    try {
      sheet.getRange(2, 1, 1000, headers.length)
           .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);
    } catch (e) {}
  }
}

function _initHistorySheet(ss) {
  if (ss.getSheetByName(HISTORY_SHEET)) return;
  const sheet   = ss.insertSheet(HISTORY_SHEET);
  const headers = ['Tracking Number', 'Step', 'Time', 'Location', 'Note'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
       .setBackground('#1E3A5F').setFontColor('#FFFFFF')
       .setFontWeight('bold').setFontSize(11);
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 180);
  sheet.setColumnWidth(5, 250);
}

function _initLogsSheet(ss) {
  if (ss.getSheetByName(LOG_SHEET)) return;
  const sheet   = ss.insertSheet(LOG_SHEET);
  const headers = ['Timestamp', 'Level', 'Context', 'Message'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
       .setBackground('#3D0000').setFontColor('#FFFFFF')
       .setFontWeight('bold').setFontSize(11);
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidth(2,  80);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 400);
}

// ═══════════════════════════════════════════════════════════════
// doGet — READ tracking data + ping only
// [#3] Admin actions removed from doGet entirely — see doPost.
// ═══════════════════════════════════════════════════════════════
function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};

  // ── Health / config ping
  if (params.action === 'ping') {
    const ss      = getSpreadsheet();
    const configOk = SITE_URL !== 'YOUR_SITE_URL_HERE';
    const sheetOk  = !!ss.getSheetByName(SHEET_NAME);
    return buildResponse({
      ok: configOk && sheetOk,
      version: VERSION,
      ts: new Date().toISOString(),
      checks: {
        site_url_configured:  configOk,
        tracking_sheet_exists: sheetOk,
      },
    });
  }

  // ── Reject any attempt to use admin actions over GET [#3]
  const ADMIN_ACTIONS = ['createOrder', 'updateStatus', 'lookupOrder'];
  if (ADMIN_ACTIONS.includes(params.action)) {
    return buildResponse({
      error:   'METHOD_NOT_ALLOWED',
      message: 'Admin actions must be sent via POST with a JSON body.',
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

  const ss     = getSpreadsheet(); // [#7] one call per request
  const result = getTrackingData(raw, ss);
  if (!result) {
    return buildResponse({ error: 'NOT_FOUND', trackingNumber: raw });
  }
  return buildResponse(result);
}

// ═══════════════════════════════════════════════════════════════
// doPost — admin actions + manual email trigger
// [#3] Admin actions now live here; key is in JSON body, not URL.
// [FIX-E] sendEmail action is now rate-limited.
// ═══════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const action = body.action || '';

    // ── Manual email trigger
    // [FIX-E] Apply rate limiting here too — this is a public endpoint
    if (action === 'sendEmail') {
      const rateLimitResult = checkRateLimit(e);
      if (rateLimitResult) return rateLimitResult;

      const raw = (body.trackingNumber || '').trim().toUpperCase();
      if (!raw || !TRACKING_REGEX.test(raw)) {
        return buildResponse({ error: 'INVALID_FORMAT' });
      }
      const ss   = getSpreadsheet(); // [#7] one call
      const data = getTrackingData(raw, ss);
      if (!data) return buildResponse({ error: 'NOT_FOUND' });
      sendStatusEmail(data);
      return buildResponse({ success: true, message: 'Email sent' });
    }

    // ── Admin actions — key validated from JSON body [#3]
    const ADMIN_ACTIONS = ['createOrder', 'updateStatus', 'lookupOrder'];
    if (ADMIN_ACTIONS.includes(action)) {
      if ((body.adminKey || '') !== ADMIN_KEY) {
        return buildResponse({ error: 'UNAUTHORIZED', message: 'Invalid admin key.' });
      }
      const ss = getSpreadsheet(); // [#7] one call
      try {
        if (action === 'createOrder')  return handleCreateOrder(body, ss);
        if (action === 'updateStatus') return handleUpdateStatus(body, ss);
        if (action === 'lookupOrder')  return handleLookupOrder(body, ss);
      } catch (err) {
        writeLog('ERROR', 'adminAction', action + ' threw: ' + err.message);
        return buildResponse({ error: 'SERVER_ERROR', message: err.message });
      }
    }

    return buildResponse({ error: 'UNKNOWN_ACTION' });
  } catch (err) {
    writeLog('ERROR', 'doPost', err.message);
    return buildResponse({ error: 'SERVER_ERROR', message: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
// checkRateLimit — fixed-window CacheService rate limiting [#9]
// Stores { count, windowStart } as JSON so the window is truly
// fixed and the TTL does not reset on every increment.
// ═══════════════════════════════════════════════════════════════
function checkRateLimit(e) {
  try {
    const userKey = 'rate_' + Session.getTemporaryActiveUserToken();
    const cache   = CacheService.getScriptCache();
    const now     = Date.now();
    let count       = 0;
    let windowStart = now;

    const cached = cache.get(userKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (now - parsed.windowStart < RATE_LIMIT_WINDOW_SECONDS * 1000) {
          count       = parsed.count;
          windowStart = parsed.windowStart;
        }
      } catch (_) {}
    }

    if (count >= RATE_LIMIT_MAX_REQUESTS) {
      const retryAfter = Math.ceil((windowStart + RATE_LIMIT_WINDOW_SECONDS * 1000 - now) / 1000);
      writeLog('WARN', 'checkRateLimit', 'Rate limit exceeded for key: ' + userKey.slice(-8));
      return buildResponse({
        error:              'RATE_LIMITED',
        message:            'Too many requests. Please wait a moment and try again.',
        retryAfterSeconds:  Math.max(retryAfter, 1),
      });
    }

    const remaining = Math.ceil((windowStart + RATE_LIMIT_WINDOW_SECONDS * 1000 - now) / 1000);
    cache.put(
      userKey,
      JSON.stringify({ count: count + 1, windowStart }),
      Math.max(remaining, 1)
    );
    return null;
  } catch (err) {
    writeLog('WARN', 'checkRateLimit', 'Rate limit check failed: ' + err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// getTrackingData — reads sheet row, builds response
// [#7] Accepts ss as argument — caller owns the single open call.
// [#8] Scans only tracking-number column first, then reads row.
// ═══════════════════════════════════════════════════════════════
function getTrackingData(trackingNumber, ss) {
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    writeLog('ERROR', 'getTrackingData', 'Sheet "' + SHEET_NAME + '" not found');
    return null;
  }

  // [#8] Read only the tracking-number column to find the row index
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const tnColumn    = sheet.getRange(2, COL.TRACKING_NUMBER, lastRow - 1, 1).getValues();
  let foundRowIndex = -1;
  for (let i = 0; i < tnColumn.length; i++) {
    if ((tnColumn[i][0] || '').toString().trim().toUpperCase() === trackingNumber) {
      foundRowIndex = i + 2; // 1-based, offset by header row
      break;
    }
  }
  if (foundRowIndex === -1) return null;

  // [#8] Fetch only the matched row
  const row = sheet.getRange(foundRowIndex, 1, 1, 11).getValues()[0];

  const status         = normalizeStatus(row[COL.STATUS - 1]);
  const history        = getHistoryFromSheet(trackingNumber, ss);
  const deliveryPhoto  = (row[COL.DELIVERY_PHOTO   - 1] || '').toString().trim();
  const serviceTier    = (row[COL.SERVICE_TIER      - 1] || 'Standard').toString().trim();
  const packageContents= (row[COL.PACKAGE_CONTENTS  - 1] || '').toString().trim();
  const eta            =  row[COL.ETA - 1];
  const etaFormatted   = formatDate(eta);
  const etaExpired     = isEtaExpired(eta, status);

  return {
    trackingNumber:  row[COL.TRACKING_NUMBER - 1],
    customerEmail:   maskEmail(row[COL.CUSTOMER_EMAIL - 1] || ''),
    status,
    location:        row[COL.LOCATION    - 1] || '',
    lastUpdated:     formatDate(row[COL.LAST_UPDATED - 1]),
    eta:             etaFormatted,
    etaExpired,
    customerName:    row[COL.CUSTOMER_NAME - 1] || '',
    serviceTier,
    packageContents,
    deliveryPhoto:   deliveryPhoto || null,
    history,
    version:         VERSION,
  };
}

// ═══════════════════════════════════════════════════════════════
// getHistoryFromSheet
// [#7] Accepts ss as argument.
// ═══════════════════════════════════════════════════════════════
function getHistoryFromSheet(trackingNumber, ss) {
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
        note:     (row[4] || '').toString().trim(),
      });
    }
    return history;
  }

  // Fallback — synthesize from main sheet
  const mainSheet = ss.getSheetByName(SHEET_NAME);
  if (!mainSheet) return [];
  const lastRow = mainSheet.getLastRow();
  if (lastRow < 2) return [];

  const tnColumn = mainSheet.getRange(2, COL.TRACKING_NUMBER, lastRow - 1, 1).getValues();
  for (let i = 0; i < tnColumn.length; i++) {
    if ((tnColumn[i][0] || '').toString().trim().toUpperCase() !== trackingNumber) continue;
    const row          = mainSheet.getRange(i + 2, 1, 1, 11).getValues()[0];
    const currentStatus= normalizeStatus(row[COL.STATUS - 1]);
    const currentIdx   = ALL_STEPS.indexOf(currentStatus);
    if (currentIdx === -1) return [];
    const now     = new Date();
    const history = [];
    for (let s = 0; s <= currentIdx; s++) {
      const hoursBack = (currentIdx - s) * 8;
      const d         = new Date(now.getTime() - hoursBack * 3600000);
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
// onEdit — TRIGGER: fires on Status column change
// [FIX-D] Passes ss into appendHistory and writeLog.
// ═══════════════════════════════════════════════════════════════
function onEdit(e) {
  if (!e || !e.range) return;
  const sheet = e.range.getSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const editedCol = e.range.getColumn();
  const editedRow = e.range.getRow();
  if (editedCol !== COL.STATUS || editedRow < 2) return;

  const newStatus  = normalizeStatus(e.value || '');
  const prevStatus = normalizeStatus(sheet.getRange(editedRow, COL.PREVIOUS_STATUS).getValue());

  if (!newStatus || !ALL_STEPS.includes(newStatus)) {
    writeLog('WARN', 'onEdit', 'Row ' + editedRow + ': invalid status "' + (e.value || '') + '"');
    return;
  }
  if (newStatus === prevStatus) return;

  const now = new Date();
  const ts  = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');

  // Save the old status before overwriting — same fix as handleUpdateStatus [#6]
  sheet.getRange(editedRow, COL.PREVIOUS_STATUS).setValue(prevStatus || newStatus);
  sheet.getRange(editedRow, COL.LAST_UPDATED).setValue(ts);

  const trackingNumber = sheet.getRange(editedRow, COL.TRACKING_NUMBER).getValue().toString().trim();
  const location       = sheet.getRange(editedRow, COL.LOCATION).getValue().toString().trim();

  const ss = getSpreadsheet(); // [#7] one call for the whole handler
  appendHistory(trackingNumber, newStatus, ts, location, '', ss); // [FIX-D] pass ss
  const data = getTrackingData(trackingNumber, ss);

  if (data) {
    const rawEmail = sheet.getRange(editedRow, COL.CUSTOMER_EMAIL).getValue().toString().trim();
    const sendData = Object.assign({}, data, { customerEmail: rawEmail });
    if (rawEmail && rawEmail.indexOf('@') !== -1) {
      try {
        sendStatusEmail(sendData);
        writeLog('INFO', 'onEdit', 'Email sent: ' + trackingNumber + ' → ' + newStatus, ss); // [FIX-D]
      } catch (err) {
        writeLog('ERROR', 'onEdit', 'Email FAILED: ' + trackingNumber + ' → ' + err.message, ss);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// appendHistory
// [FIX-B] Accepts optional ss param to avoid redundant open.
// ═══════════════════════════════════════════════════════════════
function appendHistory(trackingNumber, status, timestamp, location, note, ss) {
  if (!ss) ss = getSpreadsheet(); // [FIX-B] only open if not supplied
  let histSheet = ss.getSheetByName(HISTORY_SHEET);
  if (!histSheet) {
    histSheet = ss.insertSheet(HISTORY_SHEET);
    histSheet.appendRow(['Tracking Number', 'Step', 'Time', 'Location', 'Note']);
    histSheet.setFrozenRows(1);
  }
  histSheet.appendRow([trackingNumber, status, timestamp, location, note || '']);
}

// ═══════════════════════════════════════════════════════════════
// writeLog
// [FIX-C] Accepts optional ss param to avoid redundant open.
// ═══════════════════════════════════════════════════════════════
function writeLog(level, context, message, ss) {
  try {
    if (!ss) ss = getSpreadsheet(); // [FIX-C] only open if not supplied
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
// sendStatusEmail
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
// buildEmailHTML [#4]
// All customer-supplied values sanitized with escapeHtml().
// ═══════════════════════════════════════════════════════════════
function buildEmailHTML(data, statusInfo) {
  const safeName     = escapeHtml(data.customerName  || 'Valued Customer');
  const safeTN       = escapeHtml(data.trackingNumber);
  const safeLocation = escapeHtml(data.location      || '');
  const safeUpdated  = escapeHtml(data.lastUpdated   || '');
  const safeEta      = escapeHtml(data.eta           || '');
  const safePhoto    = escapeHtml(data.deliveryPhoto || '');

  const etaText = safeEta
    ? '<tr><td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Estimated Delivery:</strong></td>'
    + '<td style="padding:4px 0;font-size:13px;color:#0A1628;">' + safeEta + (data.etaExpired ? ' <span style="color:#DC2626;">(Delayed)</span>' : '') + '</td></tr>'
    : '';

  const locText = safeLocation
    ? '<tr><td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Current Location:</strong></td>'
    + '<td style="padding:4px 0;font-size:13px;color:#0A1628;">' + safeLocation + '</td></tr>'
    : '';

  const trackingLink = SITE_URL && SITE_URL !== 'YOUR_SITE_URL_HERE'
    ? SITE_URL + '?track=' + encodeURIComponent(data.trackingNumber)
    : null;

  const trackBtnHTML = trackingLink
    ? '<tr><td colspan="2" style="padding-top:20px;"><a href="' + trackingLink
    + '" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;'
    + 'padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;">Track Your Package</a></td></tr>'
    : '';

  const photoHTML = safePhoto
    ? '<div style="margin-top:16px;padding:12px;background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;">'
    + '<p style="margin:0 0 8px;font-size:11px;font-weight:700;color:#166534;letter-spacing:0.08em;">DELIVERY PHOTO</p>'
    + '<img src="' + safePhoto + '" alt="Delivery Photo" style="max-width:100%;border-radius:6px;"/></div>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Package Update — ${safeTN}</title>
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
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);">DELIVERY UPDATE</p>
                    <p style="margin:3px 0 0;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;">${COMPANY_NAME}</p>
                  </td>
                  <td align="right">
                    <span style="background:rgba(37,99,235,0.25);border:1px solid rgba(37,99,235,0.4);color:#93C5FD;font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;">${escapeHtml(data.serviceTier || 'Standard')}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- BODY -->
          <tr>
            <td style="background:#FFFFFF;padding:32px;">
              <p style="margin:0 0 24px;font-size:15px;color:#4A5568;line-height:1.5;">
                Dear <strong style="color:#0A1628;">${safeName}</strong>,
              </p>
              <div style="background:linear-gradient(135deg,#EFF6FF,#DBEAFE);border:1px solid #BFDBFE;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
                <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#1E40AF;">STATUS UPDATE</p>
                <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#1D4ED8;letter-spacing:-0.01em;">${escapeHtml(statusInfo.en)}</p>
                <p style="margin:0;font-size:14px;color:#6B7280;">${escapeHtml(statusInfo.kr)}</p>
              </div>
              <p style="margin:0 0 24px;font-size:14px;color:#4A5568;line-height:1.65;">${escapeHtml(statusInfo.msg)}</p>
              <div style="border:1px solid #E2E8F4;border-radius:10px;padding:18px;margin-bottom:8px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Tracking #:</strong></td>
                    <td style="padding:4px 0;font-size:13px;color:#0A1628;font-family:monospace;">${safeTN}</td>
                  </tr>
                  ${etaText}
                  ${locText}
                  <tr>
                    <td style="padding:4px 0;font-size:13px;color:#4A5568;"><strong>Last Updated:</strong></td>
                    <td style="padding:4px 0;font-size:13px;color:#0A1628;">${safeUpdated}</td>
                  </tr>
                  ${trackBtnHTML}
                </table>
              </div>
              ${photoHTML}
              <p style="margin:24px 0 0;font-size:12px;color:#94A3B8;line-height:1.6;border-top:1px solid #E2E8F0;padding-top:20px;">
                If you have any questions about your delivery, please contact our customer service.<br/>
                Thank you for choosing Sinsok Delivery.
              </p>
            </td>
          </tr>
          <!-- FOOTER -->
          <tr>
            <td style="background:#F8FAFC;border-radius:0 0 14px 14px;padding:18px 32px;text-align:center;">
              <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#0A1628;">신속배송 · Sinsok Delivery</p>
              <p style="margin:0;font-size:11px;color:#94A3B8;">서울특별시 강남구 · Seoul, South Korea</p>
              <p style="margin:8px 0 0;font-size:10px;color:#CBD5E1;">This is an automated notification. Please do not reply to this email.</p>
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
// HELPERS
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

// [#13] Wrapped in try/catch — malformed or error-type cell values
// return '' instead of leaking internal state.
function formatDate(val) {
  if (!val) return '';
  try {
    if (val instanceof Date) {
      return Utilities.formatDate(val, Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');
    }
    return val.toString();
  } catch (_) {
    return '';
  }
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
// generateTrackingNumber
// ═══════════════════════════════════════════════════════════════
function generateTrackingNumber(ss) {
  const sheet  = ss.getSheetByName(SHEET_NAME);
  const today  = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  const prefix = 'SS' + today + '-';
  if (!sheet) return prefix + '001';
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return prefix + '001';
  const tnCol = sheet.getRange(2, COL.TRACKING_NUMBER, lastRow - 1, 1).getValues();
  let count = 0;
  for (let i = 0; i < tnCol.length; i++) {
    const tn = (tnCol[i][0] || '').toString().toUpperCase();
    if (tn.startsWith(prefix)) count++;
  }
  return prefix + String(count + 1).padStart(3, '0');
}

// ═══════════════════════════════════════════════════════════════
// handleCreateOrder — admin action (POST only) [#3]
// [#14] All params capped at safe max lengths.
// ═══════════════════════════════════════════════════════════════
function handleCreateOrder(body, ss) {
  const customerName    = cap(body.customerName    || '',          MAX.NAME);
  const email           = cap(body.email           || '',          MAX.EMAIL);
  const packageContents = cap(body.packageContents || '',          MAX.CONTENTS);
  const destination     = cap(body.destination     || '',          MAX.LOCATION);
  const serviceTier     = cap(body.serviceTier     || 'Standard',  MAX.TIER);
  const eta             = cap(body.eta             || '',          MAX.ETA);

  if (!customerName || !email || email.indexOf('@') === -1) {
    return buildResponse({ error: 'MISSING_FIELDS', message: 'Customer name and valid email are required.' });
  }

  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return buildResponse({ error: 'SHEET_NOT_FOUND' });

  const trackingNumber = generateTrackingNumber(ss);
  const now = new Date();
  const ts  = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');
  const loc = destination || 'Warehouse';

  sheet.appendRow([
    trackingNumber,
    email,
    'order_received',
    loc,
    ts,
    eta,
    customerName,
    '',
    '',
    serviceTier,
    packageContents,
  ]);

  appendHistory(trackingNumber, 'order_received', ts, loc, '', ss); // [FIX-B] pass ss

  const orderData = {
    trackingNumber,
    customerName,
    customerEmail:   email,
    status:          'order_received',
    location:        loc,
    lastUpdated:     ts,
    eta,
    serviceTier,
    packageContents,
    deliveryPhoto:   null,
  };

  try {
    sendConfirmationEmail(orderData);
  } catch (emailErr) {
    writeLog('ERROR', 'handleCreateOrder', 'Email failed (order still created): ' + emailErr.message, ss);
  }

  writeLog('INFO', 'handleCreateOrder', 'Created: ' + trackingNumber + ' for ' + email, ss);
  return buildResponse({ success: true, trackingNumber });
}

// ═══════════════════════════════════════════════════════════════
// handleUpdateStatus — admin action (POST only) [#3]
// [#6] OLD status saved to PREVIOUS_STATUS before overwriting.
// [#14] params capped at safe max lengths.
// ═══════════════════════════════════════════════════════════════
function handleUpdateStatus(body, ss) {
  const raw       = cap(body.trackingNumber || '', 40).toUpperCase();
  const newStatus = normalizeStatus(body.status   || '');
  const location  = cap(body.location       || '', MAX.LOCATION);
  const note      = cap(body.note           || '', MAX.NOTE);

  if (!raw || !TRACKING_REGEX.test(raw)) {
    return buildResponse({ error: 'INVALID_FORMAT' });
  }
  if (!ALL_STEPS.includes(newStatus)) {
    return buildResponse({ error: 'INVALID_STATUS', message: 'Unknown status value.' });
  }

  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) return buildResponse({ error: 'SHEET_NOT_FOUND' });

  // [#8] Scan only the tracking-number column
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return buildResponse({ error: 'NOT_FOUND' });

  const tnColumn = sheet.getRange(2, COL.TRACKING_NUMBER, lastRow - 1, 1).getValues();
  let foundRow = -1;
  for (let i = 0; i < tnColumn.length; i++) {
    if ((tnColumn[i][0] || '').toString().trim().toUpperCase() === raw) {
      foundRow = i + 2;
      break;
    }
  }
  if (foundRow === -1) return buildResponse({ error: 'NOT_FOUND' });

  const now = new Date();
  const ts  = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy HH:mm');
  const loc = location || sheet.getRange(foundRow, COL.LOCATION).getValue().toString().trim();

  // [#6] Read current status BEFORE overwriting, store it as previous
  const oldStatus = sheet.getRange(foundRow, COL.STATUS).getValue().toString().trim();
  sheet.getRange(foundRow, COL.PREVIOUS_STATUS).setValue(oldStatus);
  sheet.getRange(foundRow, COL.STATUS).setValue(newStatus);
  sheet.getRange(foundRow, COL.LAST_UPDATED).setValue(ts);
  if (location) sheet.getRange(foundRow, COL.LOCATION).setValue(location);

  appendHistory(raw, newStatus, ts, loc, note, ss); // [FIX-B] pass ss

  const trackingData = getTrackingData(raw, ss);
  if (trackingData) {
    const rawEmail = sheet.getRange(foundRow, COL.CUSTOMER_EMAIL).getValue().toString().trim();
    if (rawEmail && rawEmail.indexOf('@') !== -1) {
      try {
        const sendData = Object.assign({}, trackingData, { customerEmail: rawEmail });
        sendStatusEmail(sendData);
        writeLog('INFO', 'handleUpdateStatus', 'Email sent: ' + raw + ' → ' + newStatus, ss);
      } catch (err) {
        writeLog('ERROR', 'handleUpdateStatus', 'Email FAILED: ' + raw + ' → ' + err.message, ss);
      }
    }
  }

  writeLog('INFO', 'handleUpdateStatus', raw + ' → ' + newStatus + ' (was: ' + oldStatus + ')', ss);
  return buildResponse({ success: true, trackingNumber: raw, newStatus, previousStatus: oldStatus });
}

// ═══════════════════════════════════════════════════════════════
// handleLookupOrder — admin action (POST only) [#3]
// ═══════════════════════════════════════════════════════════════
function handleLookupOrder(body, ss) {
  const raw = cap(body.trackingNumber || '', 40).toUpperCase();
  if (!raw || !TRACKING_REGEX.test(raw)) {
    return buildResponse({ error: 'INVALID_FORMAT' });
  }
  const data = getTrackingData(raw, ss);
  if (!data) return buildResponse({ error: 'NOT_FOUND' });
  return buildResponse({
    trackingNumber:  data.trackingNumber,
    customerName:    data.customerName,
    status:          data.status,
    location:        data.location,
    lastUpdated:     data.lastUpdated,
    eta:             data.eta,
    serviceTier:     data.serviceTier,
    packageContents: data.packageContents,
  });
}

// ═══════════════════════════════════════════════════════════════
// sendConfirmationEmail
// ═══════════════════════════════════════════════════════════════
function sendConfirmationEmail(data) {
  const email = data.customerEmail;
  if (!email || email.indexOf('@') === -1) return;
  const subject = '[' + COMPANY_KR + '] Order Confirmed — ' + data.trackingNumber;
  const html    = buildConfirmationEmailHTML(data);
  GmailApp.sendEmail(email, subject, '', { htmlBody: html, name: COMPANY_NAME });
  writeLog('INFO', 'sendConfirmationEmail', 'Sent to ' + email + ' — ' + data.trackingNumber);
}

// ═══════════════════════════════════════════════════════════════
// buildConfirmationEmailHTML [#10]
// All customer-supplied values sanitized with escapeHtml().
// [FIX-F] safeLoc ternary was truncated/unclosed in original PDF.
// ═══════════════════════════════════════════════════════════════
function buildConfirmationEmailHTML(data) {
  const safeName    = escapeHtml(data.customerName    || 'Valued Customer');
  const safeTN      = escapeHtml(data.trackingNumber);
  const safeEta     = escapeHtml(data.eta             || '');
  const safeContents= escapeHtml(data.packageContents || '');
  const safeTier    = escapeHtml(data.serviceTier     || '');
  const safeUpdated = escapeHtml(data.lastUpdated     || '');
  // [FIX-F] Ternary was cut off — completed correctly:
  const safeLoc = escapeHtml(
    data.location && data.location !== 'Warehouse' ? data.location : ''
  );

  const trackingLink = SITE_URL + '?track=' + encodeURIComponent(data.trackingNumber);

  const etaRow = safeEta
    ? '<tr><td style="padding:5px 0;font-size:13px;color:#4A5568;width:160px;"><strong>Est. Delivery:</strong></td>'
    + '<td style="padding:5px 0;font-size:13px;color:#0A1628;">' + safeEta + '</td></tr>'
    : '';

  const contentsRow = safeContents
    ? '<tr><td style="padding:5px 0;font-size:13px;color:#4A5568;"><strong>Package Contents:</strong></td>'
    + '<td style="padding:5px 0;font-size:13px;color:#0A1628;">' + safeContents + '</td></tr>'
    : '';

  const tierRow = safeTier
    ? '<tr><td style="padding:5px 0;font-size:13px;color:#4A5568;"><strong>Service Tier:</strong></td>'
    + '<td style="padding:5px 0;font-size:13px;color:#0A1628;">' + safeTier + '</td></tr>'
    : '';

  const locRow = safeLoc
    ? '<tr><td style="padding:5px 0;font-size:13px;color:#4A5568;"><strong>Destination:</strong></td>'
    + '<td style="padding:5px 0;font-size:13px;color:#0A1628;">' + safeLoc + '</td></tr>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Order Confirmed — ${safeTN}</title>
</head>
<body style="margin:0;padding:0;background:#F4F6FA;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6FA;padding:32px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
          <tr>
            <td style="background:#0A1628;border-radius:14px 14px 0 0;padding:24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);">ORDER CONFIRMATION</p>
                    <p style="margin:3px 0 0;font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;">${COMPANY_NAME}</p>
                  </td>
                  <td align="right">
                    <span style="background:rgba(16,185,129,0.25);border:1px solid rgba(16,185,129,0.4);color:#6EE7B7;font-size:11px;font-weight:600;padding:4px 10px;border-radius:20px;">Order Confirmed</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background:#FFFFFF;padding:32px;">
              <p style="margin:0 0 20px;font-size:15px;color:#4A5568;line-height:1.5;">
                Dear <strong style="color:#0A1628;">${safeName}</strong>,
              </p>
              <p style="margin:0 0 24px;font-size:14px;color:#4A5568;line-height:1.65;">
                Thank you for choosing Sinsok Delivery. Your order has been received and is now being processed.
              </p>
              <div style="background:linear-gradient(135deg,#EFF6FF,#DBEAFE);border:1px solid #BFDBFE;border-radius:12px;padding:20px 24px;margin-bottom:24px;text-align:center;">
                <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#1E40AF;">YOUR TRACKING NUMBER</p>
                <p style="margin:0 0 18px;font-size:28px;font-weight:700;color:#1D4ED8;letter-spacing:0.04em;font-family:monospace;">${safeTN}</p>
                <a href="${trackingLink}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;">Track Your Package</a>
              </div>
              <div style="border:1px solid #E2E8F4;border-radius:10px;padding:18px;margin-bottom:20px;">
                <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748B;">ORDER DETAILS</p>
                <table width="100%" cellpadding="0" cellspacing="0">
                  ${contentsRow}
                  ${locRow}
                  ${tierRow}
                  ${etaRow}
                  <tr>
                    <td style="padding:5px 0;font-size:13px;color:#4A5568;"><strong>Order Date:</strong></td>
                    <td style="padding:5px 0;font-size:13px;color:#0A1628;">${safeUpdated}</td>
                  </tr>
                  <tr>
                    <td style="padding:5px 0;font-size:13px;color:#4A5568;"><strong>Status:</strong></td>
                    <td style="padding:5px 0;font-size:13px;color:#2563EB;font-weight:600;">Order Received</td>
                  </tr>
                </table>
              </div>
              <p style="margin:0 0 24px;font-size:13px;color:#4A5568;line-height:1.65;background:#F8FAFC;border-radius:8px;padding:14px 16px;">
                <strong>What happens next?</strong> We'll send you an email update every time your package status changes. You can also track your package anytime using the link above.
              </p>
              <p style="margin:0;font-size:12px;color:#94A3B8;line-height:1.6;border-top:1px solid #E2E8F0;padding-top:20px;">
                If you have any questions about your delivery, please contact our customer service.<br/>
                Thank you for choosing Sinsok Delivery.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#F8FAFC;border-radius:0 0 14px 14px;padding:18px 32px;text-align:center;">
              <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#0A1628;">신속배송 · Sinsok Delivery</p>
              <p style="margin:0;font-size:11px;color:#94A3B8;">서울특별시 강남구 · Seoul, South Korea</p>
              <p style="margin:8px 0 0;font-size:10px;color:#CBD5E1;">This is an automated notification. Please do not reply to this email.</p>
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
// TEST FUNCTIONS [#12]
// Guarded — these will NOT execute when called from a web app
// entry point (doGet / doPost). Run them manually in the editor.
// ═══════════════════════════════════════════════════════════════
function testEmailSend() {
  if (typeof ScriptApp !== 'undefined' && ScriptApp.getService().isEnabled()) {
    const callerInfo = Session.getActiveUser().getEmail();
    if (!callerInfo) {
      throw new Error('testEmailSend() must be run manually in the Apps Script editor only.');
    }
  }
  const TEST_EMAIL = 'YOUR_TEST_EMAIL@gmail.com';
  if (TEST_EMAIL === 'YOUR_TEST_EMAIL@gmail.com') {
    throw new Error('Replace YOUR_TEST_EMAIL@gmail.com with your actual email before running.');
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
  const html       = buildEmailHTML(testData, statusInfo);
  GmailApp.sendEmail(
    testData.customerEmail,
    '[TEST] ' + COMPANY_NAME + ' — Package Update',
    '',
    { htmlBody: html, name: COMPANY_NAME }
  );
  writeLog('INFO', 'testEmailSend', 'Test email sent to ' + TEST_EMAIL);
  Logger.log('✅ Test email sent to ' + TEST_EMAIL);
}

function testRateLimit() {
  Logger.log('Rate limiting uses fixed-window CacheService (v3.1).');
  Logger.log('Window: ' + RATE_LIMIT_WINDOW_SECONDS + 's, Max: ' + RATE_LIMIT_MAX_REQUESTS + ' requests.');
  Logger.log('State stored as JSON { count, windowStart } — TTL no longer slides on increment.');
}
