import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, activityLog, agentConfigRevisions, companies, companyMemberships, companySecretBindings, companySecrets, createDb, principalPermissionGrants } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("agent secret binding authorization over HTTP", () => {
  let db: ReturnType<typeof createDb>;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-binding-authz");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  }, 30_000);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(companySecretBindings);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await cleanup?.(); });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const secretId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Binding test", issuePrefix: `B${companyId.slice(0, 7)}`.toUpperCase() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Self", role: "engineer", adapterType: "codex_local", adapterConfig: { env: {} }, runtimeConfig: {}, status: "idle" });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, status: "active" });
    await db.insert(companySecrets).values({ id: secretId, companyId, name: `synthetic-${secretId}`, key: `synthetic-${secretId}` });
    return { companyId, agentId, secretId };
  }
  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", agentRoutes(db));
    instance.use(errorHandler);
    return instance;
  }
  const ref = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });

  it("allows ordinary self config but denies a new binding without any writes", async () => {
    const f = await fixture();
    const self = app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" });
    const plain = await request(self).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { modelReasoningEffort: "high" } });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    const denied = await request(self).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } });
    expect(denied.status).toBe(403);
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect((saved.adapterConfig as { env: Record<string, unknown> }).env).toEqual({});
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
  });

  it("allows exact persisted reuse and rejects a selector change", async () => {
    const f = await fixture();
    await db.update(agents).set({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } }).where(eq(agents.id, f.agentId));
    await db.insert(companySecretBindings).values({ companyId: f.companyId, targetType: "agent", targetId: f.agentId, secretId: f.secretId, configPath: "env.OPENAI_API_KEY" });
    const self = app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" });
    const reuse = await request(self).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } });
    expect(reuse.status, JSON.stringify(reuse.body)).toBe(200);
    expect((await request(self).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { env: { OPENAI_API_KEY: { ...ref(f.secretId), version: 1 } } } })).status).toBe(403);
    expect((await db.select().from(companySecretBindings))[0].versionSelector).toBe("latest");
  });

  it.each([
    ["another env path", { env: { CODEX_API_KEY: { type: "secret_ref", secretId: "SECRET", version: "latest" } } }],
    ["projection key", { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "SECRET", projectionAllowlistKey: "changed" } } }],
    ["pinned version", { env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "SECRET", version: 1 } } }],
  ])("rejects self binding changes in %s", async (_label, template) => {
    const f = await fixture();
    await db.update(agents).set({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } }).where(eq(agents.id, f.agentId));
    await db.insert(companySecretBindings).values({ companyId: f.companyId, targetType: "agent", targetId: f.agentId, secretId: f.secretId, configPath: "env.OPENAI_API_KEY" });
    const config = JSON.parse(JSON.stringify(template).replaceAll("SECRET", f.secretId));
    const result = await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" }))
      .patch(`/api/agents/${f.agentId}`).send({ adapterConfig: config });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect(await db.select().from(companySecretBindings)).toHaveLength(1);
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect((saved.adapterConfig as { env: Record<string, unknown> }).env).toEqual({ OPENAI_API_KEY: ref(f.secretId) });
  });

  it("treats a legacy config ref without a persisted row as a new binding", async () => {
    const f = await fixture();
    await db.update(agents).set({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } }).where(eq(agents.id, f.agentId));
    const result = await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" }))
      .patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } });
    expect(result.status).toBe(403);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
  });

  it("requires a real agent configuration grant for a concrete target", async () => {
    const f = await fixture();
    const configuratorId = randomUUID();
    await db.insert(agents).values({ id: configuratorId, companyId: f.companyId, name: "Configurator", role: "engineer", adapterType: "codex_local", adapterConfig: {}, status: "idle" });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: configuratorId, status: "active" });
    const caller = app({ type: "agent", companyId: f.companyId, agentId: configuratorId, source: "agent_key" });
    const body = { adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } };
    const denied = await request(caller).patch(`/api/agents/${f.agentId}`).send(body);
    expect(denied.status).toBe(403);
    expect(denied.body.details?.reason).toBe("deny_no_grant");
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: configuratorId, permissionKey: "agents:configure" });
    const result = await request(caller).patch(`/api/agents/${f.agentId}`).send(body);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(await db.select().from(companySecretBindings)).toHaveLength(1);
    const foreign = await request(app({ type: "agent", companyId: randomUUID(), agentId: configuratorId, source: "agent_key" }))
      .patch(`/api/agents/${f.agentId}`).send(body);
    expect(foreign.status).toBe(404);
  });

  it("rejects a peer and conceals a foreign tenant target", async () => {
    const f = await fixture();
    const peerId = randomUUID();
    await db.insert(agents).values({ id: peerId, companyId: f.companyId, name: "Peer", role: "engineer", adapterType: "codex_local", adapterConfig: {}, status: "idle" });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: peerId, status: "active" });
    const body = { adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } };
    const peer = await request(app({ type: "agent", companyId: f.companyId, agentId: peerId, source: "agent_key" }))
      .patch(`/api/agents/${f.agentId}`).send(body);
    expect(peer.status).toBe(403);
    const foreign = await request(app({ type: "agent", companyId: randomUUID(), agentId: peerId, source: "agent_key" }))
      .patch(`/api/agents/${f.agentId}`).send(body);
    expect(foreign.status).toBe(404);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
  });

  it("rejects a replacement config that moves the ref to another env path", async () => {
    const f = await fixture();
    await db.update(agents).set({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } }).where(eq(agents.id, f.agentId));
    await db.insert(companySecretBindings).values({ companyId: f.companyId, targetType: "agent", targetId: f.agentId, secretId: f.secretId, configPath: "env.OPENAI_API_KEY" });
    const result = await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" }))
      .patch(`/api/agents/${f.agentId}`).send({ replaceAdapterConfig: true, adapterConfig: { env: { CODEX_API_KEY: ref(f.secretId) } } });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect((await db.select().from(companySecretBindings))[0].configPath).toBe("env.OPENAI_API_KEY");
  });

  it("does not treat hire permission as permission to bind a new target", async () => {
    const f = await fixture();
    await db.update(agents).set({ permissions: { canCreateAgents: true } }).where(eq(agents.id, f.agentId));
    const result = await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" }))
      .post(`/api/companies/${f.companyId}/agent-hires`).send({ name: "New child", role: "engineer", adapterType: "codex_local", adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
  });

  it("denies direct creation with a new binding before creating an agent", async () => {
    const f = await fixture();
    await db.update(agents).set({ permissions: { canCreateAgents: true } }).where(eq(agents.id, f.agentId));
    const result = await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" }))
      .post(`/api/companies/${f.companyId}/agents`)
      .send({ name: "Direct child", role: "engineer", adapterType: "codex_local", adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect(await db.select().from(agents).where(eq(agents.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
  });

  it("denies a schema secret field before creating managed secret material", async () => {
    const f = await fixture();
    await db.update(agents).set({ adapterType: "hermes_gateway", adapterConfig: { apiBaseUrl: "https://example.invalid" } }).where(eq(agents.id, f.agentId));
    const result = await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" }))
      .patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { apiKey: "synthetic-dummy-value" } });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
  });

  it("requires bind authority when rollback restores a removed ref", async () => {
    const f = await fixture();
    const board = app({ type: "board", userId: "operator", source: "local_implicit" });
    expect((await request(board).patch(`/api/agents/${f.agentId}`).send({ adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } })).status).toBe(200);
    const [bindingRevision] = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, f.agentId));
    expect(bindingRevision).toBeDefined();
    expect((await request(board).patch(`/api/agents/${f.agentId}`).send({ replaceAdapterConfig: true, adapterConfig: { env: {} } })).status).toBe(200);
    const rollback = await request(app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" }))
      .post(`/api/agents/${f.agentId}/config-revisions/${bindingRevision.id}/rollback`).send({});
    expect(rollback.status, JSON.stringify(rollback.body)).toBe(403);
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
  });

  it("checks bindings carried through an adapter switch", async () => {
    const f = await fixture();
    const self = app({ type: "agent", companyId: f.companyId, agentId: f.agentId, source: "agent_key" });
    const plain = await request(self).patch(`/api/agents/${f.agentId}`)
      .send({ adapterType: "claude_local", adapterConfig: { env: {} } });
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    const result = await request(self).patch(`/api/agents/${f.agentId}`)
      .send({ adapterType: "codex_local", adapterConfig: { env: { OPENAI_API_KEY: ref(f.secretId) } } });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect(result.body.details?.reason).toBe("deny_no_grant");
    expect(await db.select().from(companySecretBindings)).toHaveLength(0);
    const [saved] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(saved.adapterType).toBe("claude_local");
  });
});
