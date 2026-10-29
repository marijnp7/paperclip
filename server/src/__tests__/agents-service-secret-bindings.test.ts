import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { secretService } from "../services/secrets.js";
import { newAgentSecretBindings } from "../services/agent-binding-authorization.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent secret binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service secret binding sync", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-agent-secret-bindings-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("agent-secret-bindings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  const authorizedHire = (companyId: string, data: Parameters<ReturnType<typeof createAgentLifecycle>["requestHire"]>[1]) =>
    createAgentLifecycle(db).requestHire(companyId, { id: randomUUID(), ...data }, {
      assertSecretBindingChange: async () => {},
    });

  it("serializes a denied and authorized binding update on the same agent", async () => {
    const companyId = await seedCompany();
    const secretId = randomUUID();
    await db.insert(companySecrets).values({ id: secretId, companyId, name: `synthetic-${secretId}`, key: `synthetic-${secretId}` });
    const deniedSecretId = randomUUID();
    await db.insert(companySecrets).values({ id: deniedSecretId, companyId, name: `synthetic-${deniedSecretId}`, key: `synthetic-${deniedSecretId}` });
    const agent = await createAgentLifecycle(db).requestHire(companyId, {
      name: "Race target", adapterType: "codex_local", adapterConfig: { env: {} },
    });
    const patch = { adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref" as const, secretId } } } };
    const [denied, allowed] = await Promise.allSettled([
      agentService(db).update(agent.id, { adapterConfig: { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: deniedSecretId } } } }),
      agentService(db).update(agent.id, patch, { assertSecretBindingChange: async () => {} }),
    ]);
    expect(denied.status).toBe("rejected");
    expect(allowed.status).toBe("fulfilled");
    const bindings = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, agent.id));
    expect(bindings).toHaveLength(1);
    const [saved] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(saved.adapterConfig).toMatchObject(patch.adapterConfig);
  });

  it("compares all persisted binding fields including projection class and key", async () => {
    const companyId = await seedCompany();
    const secretId = randomUUID();
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Comparison target", role: "engineer", adapterType: "codex_local", adapterConfig: {} });
    await db.insert(companySecrets).values({ id: secretId, companyId, name: `synthetic-${secretId}`, key: `synthetic-${secretId}` });
    await db.insert(companySecretBindings).values({ companyId, targetType: "agent", targetId: agentId, secretId, configPath: "env.SLACK_BOT_TOKEN", versionSelector: "3", projectionClass: "class_3_static_lease", projectionAllowlistKey: "slack.bot_token" });
    const binding = { type: "secret_ref", secretId, version: 3, projectionClass: "class_3_static_lease", projectionAllowlistKey: "slack.bot_token" };
    const target = (env: Record<string, unknown>) => ({ id: agentId, companyId, adapterConfig: { env } });
    expect(await newAgentSecretBindings(db, target({ SLACK_BOT_TOKEN: binding }))).toHaveLength(0);
    for (const changed of [
      { ...binding, version: 2 },
      { ...binding, projectionClass: "unclassified" },
      { ...binding, projectionAllowlistKey: "another.key" },
      { ...binding, secretId: randomUUID() },
    ]) expect(await newAgentSecretBindings(db, target({ SLACK_BOT_TOKEN: changed }))).toHaveLength(1);
    expect(await newAgentSecretBindings(db, target({ OTHER_TOKEN: binding }))).toHaveLength(1);
  });

  it("creates agent secret bindings when a new agent persists secret_ref env", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `anthropic-${randomUUID()}`,
      provider: "local_encrypted",
      value: "sk-ant-123",
    });

    const created = await authorizedHire(companyId, {
      name: "Claude Novita",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
      versionSelector: "latest",
      required: true,
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          action: "secret.binding.created",
          entityType: "agent",
          entityId: created.id,
          details: expect.objectContaining({ configPath: "env.ANTHROPIC_API_KEY" }),
        }),
      ]));
  });

  it("stores approved class-3 env lease metadata on agent secret bindings", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `slack-${randomUUID()}`,
      provider: "local_encrypted",
      value: "slack-test-token",
    });

    const created = await authorizedHire(companyId, {
      name: "Slack Briefing",
      role: "briefing",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          SLACK_BOT_TOKEN: {
            type: "secret_ref",
            secretId: secret.id,
            version: "latest",
            projectionClass: "class_3_static_lease",
            projectionAllowlistKey: "slack.bot_token",
          },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.SLACK_BOT_TOKEN",
      projectionClass: "class_3_static_lease",
      projectionAllowlistKey: "slack.bot_token",
    });
  });

  it("rejects class-3 env lease bindings outside the enumerated allowlist", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `github-${randomUUID()}`,
      provider: "local_encrypted",
      value: "github-test-token",
    });

    await expect(
      authorizedHire(companyId, {
        name: "Unlisted Static Lease",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            GITHUB_TOKEN: {
              type: "secret_ref",
              secretId: secret.id,
              version: "latest",
              projectionClass: "class_3_static_lease",
              projectionAllowlistKey: "github.token",
            },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "class_3_static_lease_not_allowed" },
    });

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("converts Hermes gateway apiKey strings into persisted secret refs", async () => {
    const companyId = await seedCompany();
    const literalApiKey = `hermes-key-${randomUUID()}`;

    const created = await authorizedHire(companyId, {
      name: "Hermes Gateway",
      role: "engineer",
      status: "idle",
      adapterType: "hermes_gateway",
      adapterConfig: {
        apiBaseUrl: "https://hermes.example",
        apiKey: literalApiKey,
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    const persistedRows = await db
      .select()
      .from(agents)
      .where(eq(agents.id, created.id));
    const persistedConfig = persistedRows[0]?.adapterConfig as Record<string, unknown>;
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
    expect(persistedConfig.apiKey).toMatchObject({
      type: "secret_ref",
      version: "latest",
    });

    const secretId = (persistedConfig.apiKey as { secretId: string }).secretId;
    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId,
      configPath: "apiKey",
      versionSelector: "latest",
      required: true,
    });

    const resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      persistedConfig,
      {
        consumerType: "agent",
        consumerId: created.id,
      },
      { adapterType: "hermes_gateway" },
    );
    expect(resolved.config.apiKey).toBe(literalApiKey);
    expect(JSON.stringify(persistedConfig)).not.toContain(literalApiKey);
  });

  it("replaces agent secret bindings when adapterConfig env changes", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const oldSecret = await secrets.create(companyId, {
      name: `old-${randomUUID()}`,
      provider: "local_encrypted",
      value: "old-value",
    });
    const nextSecret = await secrets.create(companyId, {
      name: `next-${randomUUID()}`,
      provider: "local_encrypted",
      value: "next-value",
    });

    const created = await authorizedHire(companyId, {
      name: "Binding Swapper",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OLD_KEY: { type: "secret_ref", secretId: oldSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await agentService(db).update(created.id, {
      adapterConfig: {
        env: {
          NEW_KEY: { type: "secret_ref", secretId: nextSecret.id, version: "latest" },
        },
      },
    }, { assertSecretBindingChange: async () => {} });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      secretId: nextSecret.id,
      configPath: "env.NEW_KEY",
    });
  });

  it("backfills missing secret bindings when a legacy pending agent is approved", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `legacy-${randomUUID()}`,
      provider: "local_encrypted",
      value: "legacy-value",
    });
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Legacy Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    const beforeBindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, agentId));
    expect(beforeBindings).toHaveLength(0);

    const approved = await createAgentLifecycle(db).approveHire(agentId);

    expect(approved).toMatchObject({
      activated: true,
      agent: {
        id: agentId,
        status: "paused",
        lifecycleState: "preparing",
      },
    });

    const afterBindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, agentId),
      ));

    expect(afterBindings).toHaveLength(1);
    expect(afterBindings[0]).toMatchObject({
      secretId: secret.id,
      configPath: "env.ANTHROPIC_API_KEY",
    });
  });

  it("rolls back create when binding sync fails", async () => {
    const companyId = await seedCompany();
    const missingSecretId = randomUUID();

    await expect(
      authorizedHire(companyId, {
        name: "Broken Create",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          env: {
            ANTHROPIC_API_KEY: { type: "secret_ref", secretId: missingSecretId, version: "latest" },
          },
        },
        runtimeConfig: {},
        spentMonthlyCents: 0,
        lastHeartbeatAt: null,
      }),
    ).rejects.toBeTruthy();

    const persistedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));
    expect(persistedAgents).toHaveLength(0);
  });

  it("rolls back adapterConfig updates when binding sync fails", async () => {
    const companyId = await seedCompany();
    const secrets = secretService(db);
    const validSecret = await secrets.create(companyId, {
      name: `valid-${randomUUID()}`,
      provider: "local_encrypted",
      value: "valid-value",
    });
    const created = await authorizedHire(companyId, {
      name: "Transactional Update",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
        },
      },
      runtimeConfig: {},
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });

    await expect(
      agentService(db).update(created.id, {
        adapterConfig: {
          env: {
            API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
          },
        },
      }, { assertSecretBindingChange: async () => {} }),
    ).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(created.id);
    expect(reloaded?.adapterConfig).toMatchObject({
      env: {
        API_KEY: { type: "secret_ref", secretId: validSecret.id, version: "latest" },
      },
    });

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "agent"),
        eq(companySecretBindings.targetId, created.id),
      ));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.secretId).toBe(validSecret.id);
  });

  it("keeps pending approval status when activation binding sync fails", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Broken Pending Agent",
      role: "engineer",
      status: "pending_approval",
      adapterType: "claude_local",
      adapterConfig: {
        env: {
          ANTHROPIC_API_KEY: { type: "secret_ref", secretId: randomUUID(), version: "latest" },
        },
      },
      runtimeConfig: {},
      permissions: {},
    });

    await expect(createAgentLifecycle(db).approveHire(agentId)).rejects.toBeTruthy();

    const reloaded = await agentService(db).getById(agentId);
    expect(reloaded?.status).toBe("pending_approval");
  });
});
