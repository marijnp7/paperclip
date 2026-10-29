# LAT-15198: self-patch secret binding scope and risk

Base: `c7f78738aafe74cf3ae95de95d4b23e968083570` (`origin/master`, fetched 2026-10-29). This is a preparation artifact, not a deployment. No production probe or real secret material was used.

## Finding

`PATCH /agents/:id` obtains ordinary `agent_config:update` authorization in `server/src/routes/agents.ts` (near 5203-5431). That decision can allow self configuration. `server/src/services/agent-configuration.ts` then synchronizes `secret_ref` declarations through `agentCredentialService.syncAgentSecretBindings`. The latter calls `syncAgentAdapterEnvBindings`, which replaces persisted `company_secret_bindings` rows. Nothing at that write boundary distinguishes exact reuse from a new binding. The isolated reproduction linked in the issue reports a new env-only binding created by self-patch.

## Complete agent config binding write inventory at this base

| Entry | Authorization now | Binding write | Required treatment |
| --- | --- | --- | --- |
| `PATCH /agents/:id`, merge, replace, `runner` or adapter switch | `assertCanUpdateAgent` or profile-only check | `svc.update` / `updateAndTransition` -> `completeAgentConfiguration` -> `syncAgentSecretBindings` | Compare effective post-normalization config against persisted bindings; require protected change authority for every new or changed binding. |
| `POST /agents/:id/config-revisions/:revisionId/rollback` | `assertCanUpdateAgent` | `rollbackConfigRevision` -> same update service | Same protected gate; snapshot provenance is not authorization. |
| `POST /companies/:companyId/agent-hires` | create/hire authorization and approval path | `agent-hiring.ts` prepare/initialize/complete -> `syncAgentSecretBindings` | Explicitly define target-level create authority, approved inherited refs, and pending-approval transition. No implicit grant from parent self access. |
| Agent create route | `agents:create` and route controls | `agent-hiring.ts` -> `syncAgentSecretBindings` | New target has no reusable binding; apply explicit create/configurator policy before writing. |
| Instructions path, bundle, file, skill sync and server-owned bundle materialization | route-specific update/instructions permissions | `svc.update` -> same service | Route-specific privilege alone must not permit a new secret binding; preserve existing binding exactly. |
| Internal service callers of `svc.update` / lifecycle update | caller-dependent | same service | Guard at service write boundary, with explicit trusted-system context where justified; do not rely solely on HTTP route checks. |

`server/src/services/secrets.ts` also exposes `syncSecretRefsForTarget`, which deletes and reinserts all binding rows. A future guard must compare semantic fields, not row IDs or update timestamps. `syncEnvBindingsForTarget` is a fallback path for clients without `syncSecretRefsForTarget`; include it in the audit.

## Required implementation boundary

1. Build the effective adapter config using the same merge, replace, adapter transition, defaults, redaction restoration and normalization rules as the write. Compare each `secret_ref` by `(configPath, secretId, versionSelector, projectionClass, projectionAllowlistKey)`, with the same defaults as persisted rows. A config ref without a row is a new binding, even when the old config already contained it. Deletion alone needs no new bind permission.
2. Bind the authorized actor and target to a scoped policy decision equivalent to `agent_config:update` with `requiresChangeGrant: true`, as in `routes/secrets.ts` `bindingApprovalDecision`. Consent, if supported, must name the exact binding mutation. Do not reuse generic self change consent or add a role-name exception.
3. Perform the comparison and decision against current rows inside the agent write transaction. `updateAgentConfiguration` already locks the agent row with `FOR NO KEY UPDATE`; hold it through the binding check and update. Serialize every binding writer for that agent through that lock or add a binding-specific lock. Validate company ownership, target, secret status and projection as the existing sync does.
4. Make the guard execute before *all* persistent writes. `normalizeAdapterConfigForPersistence` can create a managed local secret for a plain adapter schema secret field. The PATCH, create and hire routes call normalization before `svc.update` / `requestHire`; moving only the guard into `completeAgentConfiguration` would deny too late. Use a side-effect-free validation phase and perform materialization inside the authorized transaction, or reject that input before normalization when authority is absent.
5. Preserve legitimate configurator and exact reuse behavior; do not make `allow_self` itself a bind grant. Return 403 on denied changes with no adapter config, binding or new secret rows committed.

## Regression proof required before review/merge

Use an isolated database and real HTTP authz, with synthetic refs and no material. Assert 200 for ordinary self config and exact persisted reuse; 403 for new self binding and unchanged agent + binding rows; positive explicit configurator; negative peer and tenant. Cover merge, replace, adapter switch, selector, projection class/key, env path and legacy config ref without row. Exercise rollback, create/hire, instructions and skill routes that can write config. Test a denied plain schema secret field for zero new secret rows and a concurrent check/write race. Pin output to the tested commit.

## Risk / disposition

This is a cross-cutting security boundary. A PATCH-only change would leave rollback, create/hire or other config writers as bypasses; a post-normalization denial can leave secret material behind. This issue remains preparation only; merge/deploy requires the parent governance path and Marijn board approval.

## Implementation after CTO scope decision

The branch now checks the five semantic binding fields against persisted rows. PATCH and create/hire preflight normalized config without materializing schema secret fields, then run the actual normalization inside the write transaction. The shared agent configuration writer rejects new bindings unless the caller supplies an explicit authorization callback; PATCH and rollback callbacks recheck under the existing agent row lock. The create/hire route checks protected-change authority for the concrete new target, separately from `agents:create`. Approval of a pending hire cannot add a new binding through its snapshot. The existing binding-proposal approval is scoped to its approved path and secret. Direct binding writers take the same agent row lock.

The added HTTP tests use an isolated database with synthetic company-secret metadata and real authorization. They cover self config, exact reuse, new binding deny with unchanged tables, board configurator, peer and tenant, merge, replace, env path, selector, projection key, legacy ref without a row, adapter switch, rollback, hire and normalization side effects. Service tests check projection class, all five comparison fields and a concurrent conflicting update. The protected authorization path has no generic self-consent fallback.

Residual review points: the adapter-switch HTTP test proves denial and no write, but another existing adapter policy may also deny that request; projection-class comparison is proven at the service boundary rather than via the HTTP route. The direct secret binding writer is serialized with config updates, but the separate proposal approval flow deserves CTO scrutiny for its two transactions around secret creation and binding application. No production behavior is claimed until parent deployment and verification.
