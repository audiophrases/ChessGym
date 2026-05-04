const OPENING_HEADERS = ["opening_id", "opening_name", "side", "starting_fen", "description", "tags", "published", "book_max_plies_game_mode", "allow_transpositions"];
const LINE_HEADERS = ["opening_id", "line_id", "line_name", "line_group", "line_priority", "drill_side", "start_fen", "elo", "moves_pgn"];
const NODE_HEADERS = ["opening_id", "line_id", "node_id", "parent_node_id", "move_uci", "learn_prompt", "mistake_map", "fen_before", "fen_key", "fen_after", "fen_after_key"];

const SHEET_NAMES = {
  openings: "openings",
  lines: "lines",
  nodes: "nodes"
};

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  if (params.health === "1") {
    return jsonOutput_({
      ok: true,
      app: "ChessGym writer",
      activeUser: getActiveEmail_(),
      effectiveUser: getEffectiveEmail_()
    });
  }
  return htmlOutput_("ChessGym writer", [
    "<p>This endpoint accepts ChessGym new-line form posts.</p>",
    "<p>Use <code>?health=1</code> to verify deployment and sign-in identity.</p>"
  ].join(""));
}

function doPost(e) {
  try {
    const payload = parsePayload_(e);
    const auth = authorize_(payload);
    const result = createLine_(payload, auth);
    return htmlOutput_("Line written", resultHtml_(result));
  } catch (error) {
    return htmlOutput_("Write failed", `<p>${escapeHtml_(error.message || String(error))}</p>`);
  }
}

function setupScriptProperties() {
  PropertiesService.getScriptProperties().setProperties({
    SPREADSHEET_ID: "PASTE_SPREADSHEET_ID_HERE",
    ALLOWED_EMAILS: "you@example.com",
    WRITE_TOKEN: ""
  }, false);
}

function parsePayload_(e) {
  const raw = e && e.parameter && e.parameter.payload
    ? e.parameter.payload
    : e && e.postData && e.postData.contents
      ? e.postData.contents
      : "";
  if (!raw) {
    throw new Error("Missing payload.");
  }
  const payload = JSON.parse(raw);
  if (!payload || payload.action !== "createLine") {
    throw new Error("Unsupported payload action.");
  }
  return payload;
}

function authorize_(payload) {
  const props = PropertiesService.getScriptProperties();
  const allowedEmails = String(props.getProperty("ALLOWED_EMAILS") || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const expectedToken = String(props.getProperty("WRITE_TOKEN") || "").trim();
  const suppliedToken = payload && payload.auth ? String(payload.auth.writeToken || "").trim() : "";
  const activeEmail = getActiveEmail_();

  if (activeEmail && allowedEmails.indexOf(activeEmail.toLowerCase()) !== -1) {
    return { method: "google_email", email: activeEmail };
  }
  if (expectedToken && constantTimeEqual_(expectedToken, suppliedToken)) {
    return { method: "write_token", email: activeEmail || "" };
  }
  if (allowedEmails.length || expectedToken) {
    throw new Error("Not authorized. Sign in with an allowed Google account or provide the write token.");
  }
  throw new Error("Writer auth is not configured. Set ALLOWED_EMAILS or WRITE_TOKEN in Script Properties.");
}

function createLine_(payload, auth) {
  validatePayload_(payload);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    const openingSheet = getSheet_(spreadsheet, SHEET_NAMES.openings, OPENING_HEADERS);
    const lineSheet = getSheet_(spreadsheet, SHEET_NAMES.lines, LINE_HEADERS);
    const nodeSheet = getSheet_(spreadsheet, SHEET_NAMES.nodes, NODE_HEADERS);

    const openingRow = payload.opening && payload.opening.row ? payload.opening.row : null;
    const lineRow = payload.line;
    const nodes = payload.nodes;

    const openingExists = rowExists_(openingSheet, OPENING_HEADERS, { opening_id: lineRow.opening_id });
    const lineExists = rowExists_(lineSheet, LINE_HEADERS, { opening_id: lineRow.opening_id, line_id: lineRow.line_id });
    if (lineExists) {
      throw new Error(`Line already exists: ${lineRow.opening_id}/${lineRow.line_id}`);
    }
    if (!openingExists && !(payload.opening && payload.opening.create && openingRow)) {
      throw new Error(`Opening does not exist yet: ${lineRow.opening_id}. Enable "Create opening row" or add it first.`);
    }

    let openingsWritten = 0;
    if (!openingExists && payload.opening.create && openingRow) {
      appendObjectRows_(openingSheet, OPENING_HEADERS, [openingRow]);
      openingsWritten = 1;
    }
    appendObjectRows_(lineSheet, LINE_HEADERS, [lineRow]);
    appendObjectRows_(nodeSheet, NODE_HEADERS, nodes);

    return {
      openingId: lineRow.opening_id,
      lineId: lineRow.line_id,
      lineName: lineRow.line_name,
      openingsWritten,
      linesWritten: 1,
      nodesWritten: nodes.length,
      thumbnailCommand: payload.thumbnail && payload.thumbnail.command ? payload.thumbnail.command : "",
      authMethod: auth.method,
      authEmail: auth.email || ""
    };
  } finally {
    lock.releaseLock();
  }
}

function validatePayload_(payload) {
  const line = payload.line || {};
  const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  requireField_(line, "opening_id");
  requireField_(line, "line_id");
  requireField_(line, "line_name");
  requireField_(line, "drill_side");
  requireField_(line, "moves_pgn");
  if (!/^(white|black)$/i.test(line.drill_side)) {
    throw new Error("drill_side must be white or black.");
  }
  if (!nodes.length) {
    throw new Error("At least one node is required.");
  }
  if (nodes.length > 200) {
    throw new Error("Refusing to write more than 200 nodes in one line.");
  }
  nodes.forEach((node, index) => {
    requireField_(node, "opening_id");
    requireField_(node, "line_id");
    requireField_(node, "node_id");
    requireField_(node, "move_uci");
    if (node.opening_id !== line.opening_id || node.line_id !== line.line_id) {
      throw new Error(`Node ${index + 1} does not match the line identifiers.`);
    }
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(String(node.move_uci || "").toLowerCase())) {
      throw new Error(`Node ${index + 1} has invalid UCI: ${node.move_uci}`);
    }
  });
}

function requireField_(obj, key) {
  if (!String(obj[key] || "").trim()) {
    throw new Error(`Missing required field: ${key}`);
  }
}

function getSpreadsheet_() {
  const id = String(PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID") || "").trim();
  if (id && id !== "PASTE_SPREADSHEET_ID_HERE") {
    return SpreadsheetApp.openById(id);
  }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) {
    return active;
  }
  throw new Error("Set SPREADSHEET_ID in Script Properties.");
}

function getSheet_(spreadsheet, sheetName, headers) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    const lower = sheetName.toLowerCase();
    sheet = spreadsheet.getSheets().find((candidate) => candidate.getName().toLowerCase() === lower);
  }
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  ensureHeaders_(sheet, headers);
  return sheet;
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
  const missing = headers.filter((header) => current.indexOf(header) === -1);
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
  }
}

function appendObjectRows_(sheet, headers, rows) {
  const headerMap = getHeaderMap_(sheet);
  const width = sheet.getLastColumn();
  const values = rows.map((row) => {
    const valuesRow = new Array(width).fill("");
    headers.forEach((header) => {
      const column = headerMap[header];
      if (column) {
        valuesRow[column - 1] = row[header] || "";
      }
    });
    return valuesRow;
  });
  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, values.length, width).setValues(values);
}

function rowExists_(sheet, headers, criteria) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    return false;
  }
  const headerMap = {};
  values[0].forEach((header, index) => {
    headerMap[String(header).trim()] = index;
  });
  return values.slice(1).some((row) => {
    return Object.keys(criteria).every((key) => {
      const index = headerMap[key];
      return index !== undefined && String(row[index] || "").trim() === String(criteria[key] || "").trim();
    });
  });
}

function getHeaderMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((header, index) => {
    map[String(header).trim()] = index + 1;
  });
  return map;
}

function resultHtml_(result) {
  return [
    `<p><strong>${escapeHtml_(result.lineName)}</strong> was written.</p>`,
    "<ul>",
    `<li>Opening: ${escapeHtml_(result.openingId)}</li>`,
    `<li>Line: ${escapeHtml_(result.lineId)}</li>`,
    `<li>Openings rows: ${result.openingsWritten}</li>`,
    `<li>Lines rows: ${result.linesWritten}</li>`,
    `<li>Nodes rows: ${result.nodesWritten}</li>`,
    `<li>Auth: ${escapeHtml_(result.authMethod)} ${escapeHtml_(result.authEmail)}</li>`,
    "</ul>",
    result.thumbnailCommand ? `<p>Thumbnail command: <code>${escapeHtml_(result.thumbnailCommand)}</code></p>` : "",
    "<p>Republish the Sheet CSV or wait for the published feed to refresh, then reload ChessGym.</p>"
  ].join("");
}

function htmlOutput_(title, body) {
  return HtmlService.createHtmlOutput([
    "<!doctype html><html><head><base target=\"_top\">",
    `<title>${escapeHtml_(title)}</title>`,
    "<style>body{font-family:Arial,sans-serif;line-height:1.45;padding:24px;max-width:720px}code{background:#f3f4f6;padding:2px 4px;border-radius:4px}</style>",
    "</head><body>",
    `<h1>${escapeHtml_(title)}</h1>`,
    body,
    "</body></html>"
  ].join(""));
}

function jsonOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getActiveEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || "").trim();
  } catch (error) {
    return "";
  }
}

function getEffectiveEmail_() {
  try {
    return String(Session.getEffectiveUser().getEmail() || "").trim();
  } catch (error) {
    return "";
  }
}

function constantTimeEqual_(left, right) {
  if (!left || !right) {
    return false;
  }
  let mismatch = left.length === right.length ? 0 : 1;
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    mismatch |= left.charCodeAt(index % left.length) ^ right.charCodeAt(index % right.length);
  }
  return mismatch === 0;
}

function escapeHtml_(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
