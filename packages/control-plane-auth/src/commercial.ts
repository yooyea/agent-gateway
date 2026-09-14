import {
  ControlPlaneAuthorizationError,
  type ControlPlaneActor,
  type ControlPlanePermission,
  type ControlPlaneRole,
} from "./index.js";

export type CommercialPermission =
  | "commercial.plans.read"
  | "commercial.plans.write"
  | "commercial.subscriptions.read"
  | "commercial.subscriptions.write";

const ALL: ReadonlySet<CommercialPermission> = new Set([
  "commercial.plans.read",
  "commercial.plans.write",
  "commercial.subscriptions.read",
  "commercial.subscriptions.write",
]);
const READ: ReadonlySet<CommercialPermission> = new Set([
  "commercial.plans.read",
  "commercial.subscriptions.read",
]);

const ROLE_COMMERCIAL_PERMISSIONS: Record<ControlPlaneRole, ReadonlySet<CommercialPermission>> = {
  owner: ALL,
  admin: ALL,
  operator: READ,
  viewer: READ,
};

export function hasCommercialPermission(
  actor: ControlPlaneActor,
  permission: CommercialPermission,
  tenantId?: string,
) {
  return actor.bindings.some((binding) => {
    if (!ROLE_COMMERCIAL_PERMISSIONS[binding.role].has(permission)) return false;
    if (binding.scopeType === "global") return true;
    return Boolean(tenantId && binding.scopeId === tenantId);
  });
}

export function requireCommercialPermission(
  actor: ControlPlaneActor,
  permission: CommercialPermission,
  tenantId?: string,
) {
  if (!hasCommercialPermission(actor, permission, tenantId)) {
    throw new ControlPlaneAuthorizationError(
      `Control plane permission denied: ${permission}`,
      permission as unknown as ControlPlanePermission,
      tenantId,
    );
  }
}
