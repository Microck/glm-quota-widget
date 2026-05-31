#!/usr/bin/env node
import http from "node:http";

const DEFAULT_GLM_QUOTA_BASE_URL = "https://api.z.ai";
const DEFAULT_PORT = 8766;
const DEFAULT_TIMEOUT_MS = 10_000;
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const TOKEN_LIMIT = "TOKENS_LIMIT";
const TIME_LIMIT = "TIME_LIMIT";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function splitList(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readQuotaAccounts() {
  const keys = splitList(process.env.GLM_QUOTA_API_KEYS);
  if (keys.length === 0) keys.push(requiredEnv("GLM_QUOTA_API_KEY"));

  const labels = splitList(process.env.GLM_QUOTA_ACCOUNT_LABELS);
  return keys.map((apiKey, index) => ({
    apiKey,
    label: labels[index] || (keys.length === 1 ? "GLM" : `GLM ${index + 1}`),
  }));
}

function authHeaderValue(apiKey) {
  const scheme = (process.env.GLM_QUOTA_AUTH_SCHEME || "bearer").trim().toLowerCase();
  if (scheme === "raw") return apiKey;
  if (scheme === "bearer") return `Bearer ${apiKey}`;
  throw new Error("GLM_QUOTA_AUTH_SCHEME must be bearer or raw");
}

function quotaUrl() {
  const base = process.env.GLM_QUOTA_API_BASE_URL?.trim() || DEFAULT_GLM_QUOTA_BASE_URL;
  return new URL(QUOTA_PATH, base.endsWith("/") ? base : `${base}/`).toString();
}

function sanitizeSecret(message, accounts) {
  let text = String(message);
  for (const account of accounts) {
    if (account.apiKey) text = text.replaceAll(account.apiKey, "<redacted>");
  }
  return text;
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Invalid JSON response (${response.status}): ${text.slice(0, 240)}`);
  }
}

async function fetchGlmQuota(account) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(quotaUrl(), {
      signal: controller.signal,
      headers: {
        Authorization: authHeaderValue(account.apiKey),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${quotaUrl()}: ${JSON.stringify(body)}`);
    }
    if (body?.success === false || (Number.isFinite(Number(body?.code)) && Number(body.code) >= 400)) {
      throw new Error(`Z.ai quota API error: ${JSON.stringify(body)}`);
    }
    return body?.data || body || {};
  } finally {
    clearTimeout(timeout);
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function epochMillisToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number).toISOString();
}

function limitUsedPercent(limit) {
  if (Number.isFinite(Number(limit?.percentage))) return clampPercent(limit.percentage);

  const total = numberOrNull(limit?.usage);
  const used = numberOrNull(limit?.currentValue);
  if (!total || used === null) return 0;
  return clampPercent((used / total) * 100);
}

function normalizeLimit(limit, label) {
  if (!limit) return null;

  const total = numberOrNull(limit.usage);
  const used = numberOrNull(limit.currentValue);
  const remaining = numberOrNull(limit.remaining);
  const usedPercent = limitUsedPercent(limit);

  return {
    label,
    type: String(limit.type || "UNKNOWN"),
    unit: numberOrNull(limit.unit),
    number: numberOrNull(limit.number),
    used,
    total,
    remaining,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetAt: epochMillisToIso(limit.nextResetTime),
    usageDetails: Array.isArray(limit.usageDetails) ? limit.usageDetails : [],
  };
}

function isFiveHourTokenLimit(limit) {
  return limit?.type === TOKEN_LIMIT && Number(limit.unit) === 3 && Number(limit.number) === 5;
}

function isWeeklyTokenLimit(limit) {
  return limit?.type === TOKEN_LIMIT && Number(limit.unit) === 6 && Number(limit.number) === 7;
}

function findQuotaLimits(rawQuota) {
  const limits = Array.isArray(rawQuota?.limits) ? rawQuota.limits : [];
  const tokenLimits = limits.filter((limit) => limit?.type === TOKEN_LIMIT);

  return {
    fiveHour: limits.find(isFiveHourTokenLimit) || tokenLimits[0] || null,
    weekly: limits.find(isWeeklyTokenLimit) || tokenLimits.find((limit) => !isFiveHourTokenLimit(limit)) || null,
    mcp: limits.find((limit) => limit?.type === TIME_LIMIT) || null,
  };
}

function normalizeAccount(account, rawQuota) {
  const limits = findQuotaLimits(rawQuota);
  const windows = {
    fiveHour: normalizeLimit(limits.fiveHour, "5h tokens"),
    weekly: normalizeLimit(limits.weekly, "weekly tokens"),
    mcp: normalizeLimit(limits.mcp, "MCP"),
  };

  const blockingWindows = [windows.fiveHour, windows.weekly].filter(Boolean);
  const allowed = blockingWindows.every((window) => window.remainingPercent > 0.01);

  return {
    label: account.label,
    level: String(rawQuota?.level || "unknown"),
    allowed,
    windows,
  };
}

function isoBy(values, pick) {
  const times = values.filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  if (times.length === 0) return null;
  return new Date(pick(...times)).toISOString();
}

function summarizeWindow(accounts, windowKey) {
  const windows = accounts.map((account) => account.windows[windowKey]).filter(Boolean);
  const exactWindows = windows.filter((window) => (
    Number.isFinite(window.total)
    && window.total > 0
    && Number.isFinite(window.used)
    && Number.isFinite(window.remaining)
  ));

  const useExactUnits = exactWindows.length === windows.length && windows.length > 0;
  const usedUnits = useExactUnits
    ? windows.reduce((sum, window) => sum + window.used, 0)
    : windows.reduce((sum, window) => sum + window.usedPercent, 0);
  const remainingUnits = useExactUnits
    ? windows.reduce((sum, window) => sum + window.remaining, 0)
    : windows.reduce((sum, window) => sum + window.remainingPercent, 0);
  const capacityUnits = useExactUnits
    ? windows.reduce((sum, window) => sum + window.total, 0)
    : windows.length * 100;
  const usedPercent = capacityUnits > 0 ? clampPercent((usedUnits / capacityUnits) * 100) : 0;
  const exhausted = windows.filter((window) => window.remainingPercent <= 0.01);

  return {
    accountCount: windows.length,
    unitKind: useExactUnits ? "count" : "percent",
    usedPercent,
    remainingPercent: capacityUnits > 0 ? clampPercent((remainingUnits / capacityUnits) * 100) : 0,
    capacityUnits,
    usedUnits,
    remainingUnits,
    exhaustedCount: exhausted.length,
    nextRefillAt: isoBy(exhausted.map((window) => window.resetAt), Math.min),
    allCurrentUsageClearsAt: isoBy(
      windows.filter((window) => Number(window.used || 0) > 0 || window.usedPercent > 0.01).map((window) => window.resetAt),
      Math.max,
    ),
  };
}

function summarizeAccounts(accounts) {
  const blockedAccounts = accounts.filter((account) => !account.allowed);
  return {
    generatedAt: new Date().toISOString(),
    source: quotaUrl(),
    accountCount: accounts.length,
    readyAccountCount: accounts.filter((account) => account.allowed).length,
    blockedAccountCount: blockedAccounts.length,
    nextAccountReadyAt: isoBy(
      blockedAccounts.flatMap((account) => [
        account.windows.fiveHour?.resetAt,
        account.windows.weekly?.resetAt,
      ]),
      Math.min,
    ),
    windows: {
      fiveHour: summarizeWindow(accounts, "fiveHour"),
      weekly: summarizeWindow(accounts, "weekly"),
      mcp: summarizeWindow(accounts, "mcp"),
    },
    accounts,
  };
}

export async function buildQuotaSnapshot() {
  const quotaAccounts = readQuotaAccounts();
  const results = await Promise.allSettled(quotaAccounts.map(async (account) => (
    normalizeAccount(account, await fetchGlmQuota(account))
  )));
  const accounts = [];
  const errors = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "fulfilled") {
      accounts.push(result.value);
    } else {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({
        label: quotaAccounts[index]?.label || "unknown",
        message: sanitizeSecret(message, quotaAccounts),
      });
    }
  }

  return { ...summarizeAccounts(accounts), errorCount: errors.length, errors };
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(body, null, 2));
}

function requestAuthorized(requestUrl) {
  const expected = process.env.GLM_QUOTA_WIDGET_TOKEN?.trim();
  return !expected || requestUrl.searchParams.get("token") === expected;
}

export function createServer() {
  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    try {
      if (requestUrl.pathname === "/health") {
        sendJson(response, 200, { ok: true });
      } else if (requestUrl.pathname !== "/quota") {
        sendJson(response, 404, { error: "not found" });
      } else if (!requestAuthorized(requestUrl)) {
        sendJson(response, 401, { error: "invalid widget token" });
      } else {
        sendJson(response, 200, await buildQuotaSnapshot());
      }
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.GLM_QUOTA_WIDGET_PORT || DEFAULT_PORT);
  const host = process.env.GLM_QUOTA_WIDGET_HOST || "127.0.0.1";
  createServer().listen(port, host, () => {
    console.log(`glm-quota-widget listening on http://${host}:${port}/quota`);
  });
}
