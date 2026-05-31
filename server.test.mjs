import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { buildQuotaSnapshot, createServer } from "./server.mjs";

function withEnv(values, run) {
  const previous = {};
  for (const key of Object.keys(values)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function quotaFixture() {
  return {
    code: 200,
    success: true,
    data: {
      level: "pro",
      limits: [
        {
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          usage: 1000,
          currentValue: 250,
          remaining: 750,
          percentage: 25,
          nextResetTime: 1_800_000_000_000,
        },
        {
          type: "TOKENS_LIMIT",
          unit: 6,
          number: 7,
          usage: 5000,
          currentValue: 2000,
          remaining: 3000,
          percentage: 40,
          nextResetTime: 1_800_086_400_000,
        },
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 100,
          currentValue: 10,
          remaining: 90,
          percentage: 10,
          usageDetails: [{ modelCode: "web-reader", usage: 3 }],
        },
      ],
    },
  };
}

test("buildQuotaSnapshot normalizes Z.ai quota limits", async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push({
      url: request.url,
      authorization: request.headers.authorization,
    });

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(quotaFixture()));
  });

  const baseUrl = await listen(server);

  try {
    await withEnv({
      GLM_QUOTA_API_KEY: "test-key",
      GLM_QUOTA_API_KEYS: undefined,
      GLM_QUOTA_ACCOUNT_LABELS: undefined,
      GLM_QUOTA_API_BASE_URL: baseUrl,
      GLM_QUOTA_AUTH_SCHEME: "bearer",
    }, async () => {
      const snapshot = await buildQuotaSnapshot();

      assert.equal(seen.length, 1);
      assert.equal(seen[0].url, "/api/monitor/usage/quota/limit");
      assert.equal(seen[0].authorization, "Bearer test-key");
      assert.equal(snapshot.accountCount, 1);
      assert.equal(snapshot.readyAccountCount, 1);
      assert.equal(snapshot.accounts[0].level, "pro");
      assert.equal(snapshot.windows.fiveHour.remainingPercent, 75);
      assert.equal(snapshot.windows.fiveHour.remainingUnits, 750);
      assert.equal(snapshot.windows.weekly.remainingPercent, 60);
      assert.equal(snapshot.windows.weekly.capacityUnits, 5000);
      assert.equal(snapshot.windows.mcp.remainingUnits, 90);
      assert.equal(snapshot.errorCount, 0);
    });
  } finally {
    await close(server);
  }
});

test("createServer protects /quota and returns normalized JSON", async () => {
  const upstream = http.createServer((request, response) => {
    assert.equal(request.url, "/api/monitor/usage/quota/limit");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(quotaFixture()));
  });

  const upstreamBaseUrl = await listen(upstream);
  const bridge = createServer();

  try {
    await withEnv({
      GLM_QUOTA_API_KEY: "route-key",
      GLM_QUOTA_API_KEYS: undefined,
      GLM_QUOTA_ACCOUNT_LABELS: undefined,
      GLM_QUOTA_API_BASE_URL: upstreamBaseUrl,
      GLM_QUOTA_AUTH_SCHEME: "bearer",
      GLM_QUOTA_WIDGET_TOKEN: "route-token",
    }, async () => {
      const bridgeBaseUrl = await listen(bridge);

      const health = await fetch(`${bridgeBaseUrl}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const unauthorized = await fetch(`${bridgeBaseUrl}/quota?token=bad`);
      assert.equal(unauthorized.status, 401);

      const quota = await fetch(`${bridgeBaseUrl}/quota?token=route-token`);
      assert.equal(quota.status, 200);
      const body = await quota.json();
      assert.equal(body.source, `${upstreamBaseUrl}/api/monitor/usage/quota/limit`);
      assert.equal(body.windows.fiveHour.remainingUnits, 750);
      assert.equal(body.windows.weekly.remainingUnits, 3000);
      assert.equal(body.errors.length, 0);
    });
  } finally {
    await close(bridge);
    await close(upstream);
  }
});
