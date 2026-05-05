/*
  Minimal remote suggestion inbox for ChessGym.

  Cloudflare Worker bindings:
  - KV namespace: SUGGESTIONS
  - Secret: ADMIN_TOKEN
  - Optional secret: SUBMIT_TOKEN
  - Optional env: ALLOWED_ORIGINS=https://your-site.example,http://localhost:8787

  Endpoints:
  - POST /suggestions
  - GET /suggestions
  - PATCH /suggestions/:id
*/

const MAX_TEXT = {
  opening_id: 160,
  opening_name: 240,
  source_line_id: 160,
  source_line_name: 240,
  line_name: 240,
  line_id: 160,
  drill_side: 16,
  start_fen: 240,
  current_fen: 240,
  moves_text: 8000,
  notation: 24,
  comment: 4000,
  contact: 240,
  source_url: 800,
  user_agent: 400,
  admin_note: 4000
};

const STATUSES = new Set(["pending", "done", "archived"]);

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      if (!env.SUGGESTIONS) {
        return json({ error: "Missing SUGGESTIONS KV binding." }, 500, corsHeaders);
      }

      const url = new URL(request.url);
      if (url.pathname === "/suggestions" && request.method === "POST") {
        requireSubmitToken(request, env);
        const body = await readJson(request);
        const suggestion = normalizeSuggestion(body, request);
        await env.SUGGESTIONS.put(storageKey(suggestion.id), JSON.stringify(suggestion));
        return json({ ok: true, suggestion }, 200, corsHeaders);
      }

      if (url.pathname === "/suggestions" && request.method === "GET") {
        requireAdminToken(request, env);
        const suggestions = await listSuggestions(env);
        return json({ ok: true, suggestions }, 200, corsHeaders);
      }

      const match = url.pathname.match(/^\/suggestions\/([^/]+)$/);
      if (match && request.method === "PATCH") {
        requireAdminToken(request, env);
        const id = decodeURIComponent(match[1]);
        const body = await readJson(request);
        const suggestion = await updateSuggestion(env, id, body);
        return json({ ok: true, suggestion }, 200, corsHeaders);
      }

      return json({ error: "Not found" }, 404, corsHeaders);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      return json({ error: error.message || "Server error" }, status, corsHeaders);
    }
  }
};

function buildCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes("*") || !origin
    ? "*"
    : (allowed.includes(origin) ? origin : allowed[0] || origin);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-ChessGym-Submit-Token",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw httpError(400, `Invalid JSON: ${error.message}`);
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function bearerToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function requireAdminToken(request, env) {
  if (!env.ADMIN_TOKEN) {
    throw httpError(500, "Missing ADMIN_TOKEN.");
  }
  if (bearerToken(request) !== env.ADMIN_TOKEN) {
    throw httpError(401, "Unauthorized.");
  }
}

function requireSubmitToken(request, env) {
  if (!env.SUBMIT_TOKEN) {
    return;
  }
  const supplied = bearerToken(request) || request.headers.get("X-ChessGym-Submit-Token") || "";
  if (supplied !== env.SUBMIT_TOKEN) {
    throw httpError(401, "Unauthorized.");
  }
}

function clean(body, key) {
  const limit = MAX_TEXT[key] || 1000;
  const value = body[key];
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, limit);
}

function normalizeSuggestion(body, request) {
  const now = new Date().toISOString();
  const suggestion = {
    id: crypto.randomUUID(),
    status: "pending",
    created_at: now,
    updated_at: now,
    opening_id: clean(body, "opening_id"),
    opening_name: clean(body, "opening_name"),
    source_line_id: clean(body, "source_line_id"),
    source_line_name: clean(body, "source_line_name"),
    line_name: clean(body, "line_name"),
    line_id: clean(body, "line_id"),
    drill_side: clean(body, "drill_side"),
    start_fen: clean(body, "start_fen"),
    current_fen: clean(body, "current_fen"),
    moves_text: clean(body, "moves_text"),
    notation: clean(body, "notation") || "auto",
    comment: clean(body, "comment"),
    contact: clean(body, "contact"),
    source_url: clean(body, "source_url"),
    user_agent: request.headers.get("User-Agent") || ""
  };
  if (!["white", "black"].includes(suggestion.drill_side)) {
    suggestion.drill_side = "";
  }
  if (!["auto", "uci", "san"].includes(suggestion.notation)) {
    suggestion.notation = "auto";
  }
  if (!suggestion.moves_text && !suggestion.comment) {
    throw httpError(400, "Suggestion needs moves or a comment.");
  }
  return suggestion;
}

function storageKey(id) {
  return `suggestion:${id}`;
}

async function listSuggestions(env) {
  const listed = await env.SUGGESTIONS.list({ prefix: "suggestion:" });
  const rows = await Promise.all(
    listed.keys.map(async (key) => {
      const raw = await env.SUGGESTIONS.get(key.name);
      return raw ? JSON.parse(raw) : null;
    })
  );
  const statusOrder = { pending: 0, done: 1, archived: 2 };
  return rows
    .filter(Boolean)
    .sort((a, b) => {
      const byStatus = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
      if (byStatus !== 0) return byStatus;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
}

async function updateSuggestion(env, id, body) {
  const key = storageKey(id);
  const raw = await env.SUGGESTIONS.get(key);
  if (!raw) {
    throw httpError(404, "Suggestion not found.");
  }
  const suggestion = JSON.parse(raw);
  if (body.status !== undefined) {
    const status = String(body.status || "").trim().toLowerCase();
    if (!STATUSES.has(status)) {
      throw httpError(400, `Unknown suggestion status: ${status}`);
    }
    suggestion.status = status;
  }
  if (body.admin_note !== undefined) {
    suggestion.admin_note = clean(body, "admin_note");
  }
  suggestion.updated_at = new Date().toISOString();
  await env.SUGGESTIONS.put(key, JSON.stringify(suggestion));
  return suggestion;
}
