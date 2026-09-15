import {
  hasPermission,
  requirePermission,
  type ControlPlaneActor,
  type ControlPlanePermission,
} from "./index.js";

export type CommercialPermission = Extract<
  ControlPlanePermission,
  | "commercial.plans.read"
  | "commercial.plans.write"
  | "commercial.subscriptions.read"
  | "commercial.subscriptions.write"
  | "commercial.policy.read"
>;

export function hasCommercialPermission(
  actor: ControlPlaneActor,
  permission: CommercialPermission,
  tenantId?: string,
) {
  return hasPermission(actor, permission, tenantId);
}

export function requireCommercialPermission(
  actor: ControlPlaneActor,
  permission: CommercialPermission,
  tenantId?: string,
) {
  return requirePermission(actor, permission, tenantId);
}
