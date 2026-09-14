import {
  hasPermission,
  requirePermission,
  type ControlPlaneActor,
  type ControlPlanePermission,
} from "./index.js";

export type BillingPermission = Extract<ControlPlanePermission,
  | "billing.accounts.read"
  | "billing.accounts.write"
  | "billing.pricing.read"
  | "billing.pricing.write"
  | "billing.credits.write"
  | "billing.usage.read"
  | "billing.ledger.read"
  | "billing.reservations.read"
>;

export function hasBillingPermission(
  actor: ControlPlaneActor,
  permission: BillingPermission,
  tenantId?: string,
) {
  return hasPermission(actor, permission, tenantId);
}

export function requireBillingPermission(
  actor: ControlPlaneActor,
  permission: BillingPermission,
  tenantId?: string,
) {
  return requirePermission(actor, permission, tenantId);
}
