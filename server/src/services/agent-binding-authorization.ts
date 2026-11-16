import { and, eq } from "drizzle-orm";
import { companySecretBindings, type Db } from "@paperclipai/db";
import { collectSecretRefs } from "./agent-secret-bindings.js";

// Compare the binding actually persisted for this target, not the prior config:
// legacy config refs without a binding must be treated as new grants.
export async function newAgentSecretBindings(db: Db, agent: {
  id: string;
  companyId: string;
  adapterConfig: unknown;
}) {
  const persisted = await db.select().from(companySecretBindings).where(and(
    eq(companySecretBindings.companyId, agent.companyId),
    eq(companySecretBindings.targetType, "agent"),
    eq(companySecretBindings.targetId, agent.id),
  ));
  const existing = new Set(persisted.map((row) => bindingKey(row)));
  return collectSecretRefs(agent.adapterConfig).filter((ref) => !existing.has(bindingKey(ref)));
}

function bindingKey(ref: {
  configPath: string;
  secretId: string;
  versionSelector?: unknown;
  projectionClass?: unknown;
  projectionAllowlistKey?: unknown;
}) {
  return JSON.stringify([
    ref.configPath,
    ref.secretId,
    String(ref.versionSelector ?? "latest"),
    ref.projectionClass ?? "unclassified",
    ref.projectionAllowlistKey ?? null,
  ]);
}
