import type { RouteHints } from "@agent-gateway/core";
import type { CommercialPolicy } from "@agent-gateway/commercial-postgres";

export interface RuntimeAdmissionDefaults {
  requestsPerMinute: number;
  maxConcurrency: number;
}

export interface RuntimeAdmissionPolicy {
  requestsPerMinute: number;
  maxConcurrency: number;
  planId?: string;
  planVersionId?: string;
  subscriptionId?: string;
}

export function resolveRuntimeAdmission(
  policy: CommercialPolicy | undefined,
  defaults: RuntimeAdmissionDefaults,
): RuntimeAdmissionPolicy {
  return {
    requestsPerMinute: policy?.requestsPerMinute ?? defaults.requestsPerMinute,
    maxConcurrency: policy?.maxConcurrency ?? defaults.maxConcurrency,
    planId: policy?.planId,
    planVersionId: policy?.planVersionId,
    subscriptionId: policy?.subscriptionId,
  };
}

export function applyCommercialSessionBudget(
  hints: RouteHints,
  policy: CommercialPolicy | undefined,
): RouteHints {
  if (hints.budget?.max_cost_micros) return hints;
  if (!policy?.defaultSessionBudgetMicros) return hints;
  return {
    ...hints,
    budget: {
      ...hints.budget,
      max_cost_micros: policy.defaultSessionBudgetMicros,
    },
  };
}
