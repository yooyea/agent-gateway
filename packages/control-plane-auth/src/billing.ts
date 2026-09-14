import {
  ControlPlaneAuthorizationError,
  type ControlPlaneActor,
  type ControlPlanePermission,
  type ControlPlaneRole,
} from "./index.js";

export type BillingPermission = Extract<
  ControlPlanePermission,
  | "billing.accounts.read"
  | "billing.accounts.write"
  | "billing.pricing.read"
  | "billing.pricing.write"
  | "billing.credits.write"
  | "billing.usage.read"
  | "billing.ledger.read"
  | "billing.reservations.read"
>;

const BILLING_ALL: ReadonlySet<BillingPermission> = new Set([
  "billing.accounts.read",
  "billing.accounts.write",
  "billing.pricing.read",
  "billing.pricing.write",
  "billing.credits.write",
  "billing.usage.read",
  "billing.ledger.read",
  "billing.reservations.read",
]);

const BILLING_READ: ReadonlySet<BillingPermission> = new Set([
  "billing.accounts.read",
  "billing.pricing.read",
  "billing.usage.read",
  "billing.ledger.read",
  "billing.reservations.read",
]);

export const ROLE_BILLING_PERMISSIONS: Record<ControlPlaneRole, ReadonlySet<BillingPermission>> = {
  owner: BILLING_ALL,
  admin: BILLING_ALL,
  operator: BILLING_READ,
  viewer: BILLING_READ,
};

export function hasBillingPermission(
  actor: ControlPlaneActor,
  permission: BillingPermission,
  tenantId?: string,
) {
  return actor.bindings.some((binding) => {
    if (!ROLE_BILLING_PERMISSIONS[binding.role].has(permission)) return false;
    if (binding.scopeType === "global") return true;
    return Boolean(tenantId && binding.scopeType === "tenant" && binding.scopeId === tenantId);
  });
}

export function requireBillingPermission(
  actor: ControlPlaneActor,
  permission: BillingPermission,
  tenantId?: string,
) {
  if (!hasBillingPermission(actor, permission, tenantId)) {
    throw new ControlPlaneAuthorizationError(
      `Control plane permission denied: ${permission}`,
      permission,
      tenantId,
    );
  }
}
