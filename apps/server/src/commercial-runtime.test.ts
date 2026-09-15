import assert from "node:assert/strict";
import test from "node:test";
import type { CommercialPolicy } from "@agent-gateway/commercial-postgres";
import { applyCommercialSessionBudget, resolveRuntimeAdmission } from "./commercial-runtime.js";

const policy: CommercialPolicy = {
  tenantId: "tenant_1",
  subscriptionId: "agsub_1",
  planId: "agplan_pro",
  planVersionId: "agplanv_pro_1",
  includedCreditMicros: "5000000",
  defaultSessionBudgetMicros: "2000000",
  requestsPerMinute: 600,
  maxConcurrency: 40,
  entitlements: { sandbox: true },
  periodStart: "2026-09-01T00:00:00.000Z",
  periodEnd: "2026-10-01T00:00:00.000Z",
};

test("commercial policy overrides runtime admission defaults", () => {
  assert.deepEqual(resolveRuntimeAdmission(policy, {
    requestsPerMinute: 120,
    maxConcurrency: 20,
  }), {
    requestsPerMinute: 600,
    maxConcurrency: 40,
    planId: "agplan_pro",
    planVersionId: "agplanv_pro_1",
    subscriptionId: "agsub_1",
  });
});

test("runtime admission falls back when tenant has no active subscription", () => {
  assert.deepEqual(resolveRuntimeAdmission(undefined, {
    requestsPerMinute: 120,
    maxConcurrency: 20,
  }), {
    requestsPerMinute: 120,
    maxConcurrency: 20,
    planId: undefined,
    planVersionId: undefined,
    subscriptionId: undefined,
  });
});

test("plan default session budget applies only when caller did not declare one", () => {
  assert.deepEqual(applyCommercialSessionBudget({ provider: "mock" }, policy), {
    provider: "mock",
    budget: { max_cost_micros: "2000000" },
  });

  assert.deepEqual(applyCommercialSessionBudget({
    provider: "mock",
    budget: { max_cost_micros: "750000" },
  }, policy), {
    provider: "mock",
    budget: { max_cost_micros: "750000" },
  });
});
