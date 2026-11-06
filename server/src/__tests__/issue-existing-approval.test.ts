import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, issueComments, authUsers, approvals, companies, companyMemberships, createDb, issues, issueExecutionDecisions } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { approvalRecords } from "../services/approvals.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("existing board approval workflow", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("paperclip-existing-approval-"); db = createDb(temporary.connectionString); }, 30000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function fixture(invalid?: string, viaHttp = false) {
    const companyId = randomUUID(), issueId = randomUUID(), approvalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Approval test", issuePrefix: `P${companyId.slice(0, 7)}` });
    await db.insert(authUsers).values(["executor", "reviewer", "board-user"].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() }))).onConflictDoNothing();
    await db.insert(companyMemberships).values(["executor", "reviewer", "board-user"].map(principalId => ({ companyId, principalType: "user", principalId, status: "active" })));
    const foreign = randomUUID();
    if (invalid === "company") await db.insert(companies).values({ id: foreign, name: "Foreign", issuePrefix: `P${foreign.slice(0,7)}` });
    await approvalRecords(db).create(invalid === "company" ? foreign : companyId, {
      id: approvalId, type: "approve_ceo_strategy", payload: { scope: "deploy-reviewed-change", issueIds: [invalid === "issue" ? randomUUID() : issueId] },
    });
    if (invalid !== "pending") await approvalRecords(db).resolveApproval(approvalId, invalid === "rejected" ? "rejected" : "approved", invalid === "decider" ? "other-board-user" : "board-user", "Approved bounded scope");
    const policy = normalizeIssueExecutionPolicy({ stages: [
      { type: "review", participants: [{ type: "user", userId: "reviewer" }] },
      { type: "approval", participants: [{ type: "user", userId: "board-user" }], existingApproval: { approvalId, scope: invalid === "scope" ? "different-scope" : "deploy-reviewed-change" } },
    ] })!;
    await db.insert(issues).values({ id: issueId, companyId, title: "Governed work", status: "in_progress", assigneeUserId: "executor", executionPolicy: policy });
    const svc = issueService(db);
    if (viaHttp) return { svc, issueId, approvalId, companyId, policy, review: null! };
    const initial = (await svc.getById(issueId))!;
    const start = applyIssueExecutionPolicyTransition({ issue: initial, policy, requestedStatus: "done", requestedAssigneePatch: {}, actor: { userId: "executor" }, commentBody: "Ready for independent review" });
    await svc.update(issueId, { ...start.patch, actorUserId: "executor" });
    const pending = (await svc.getById(issueId))!;
    expect(pending.status).toBe("in_review");
    expect(pending.assigneeUserId).toBe("reviewer");
    const review = applyIssueExecutionPolicyTransition({ issue: pending, policy, requestedStatus: "done", requestedAssigneePatch: {}, actor: { userId: "reviewer" }, commentBody: "Independently reviewed exact change" });
    return { svc, issueId, approvalId, companyId, policy, review };
  }
  function app(companyId: string, userId: string, source: "session" | "mcp_oauth" = "session") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false, source };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(((error, _req, _res, next) => {
      if (!error.status || error.status >= 500) console.error(error);
      next(error);
    }) as express.ErrorRequestHandler);
    app.use(errorHandler);
    return app;
  }
  it("records both decisions through HTTP and preserves the original board card", async () => {
    const f = await fixture(undefined, true);
    const before = await approvalRecords(db).getById(f.approvalId);
    const submit = await request(app(f.companyId, "executor")).patch(`/api/issues/${f.issueId}`)
      .send({ status: "done", comment: "Ready for independent review" });
    expect(submit.status, JSON.stringify(submit.body)).toBe(200);
    expect(submit.body).toMatchObject({ status: "in_review", assigneeUserId: "reviewer" });
    const stateOnly = await request(app(f.companyId, "executor")).patch(`/api/issues/${f.issueId}`)
      .send({ executionState: { completedStageIds: f.policy.stages.map(stage => stage.id), phase: "completed" } });
    expect(stateOnly.status).toBe(200);
    expect(stateOnly.body.executionState).toEqual(submit.body.executionState);
    const forged = await request(app(f.companyId, "executor", "mcp_oauth")).patch(`/api/issues/${f.issueId}`)
      .send({ status: "done", comment: "Forged completion", executionState: {
        completedStageIds: f.policy.stages.map(stage => stage.id), phase: "completed",
      } });
    expect(forged.status, JSON.stringify(forged.body)).toBe(403);
    expect((await f.svc.getById(f.issueId))?.status).toBe("in_review");
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(0);
    const reviewed = await request(app(f.companyId, "reviewer")).patch(`/api/issues/${f.issueId}`)
      .send({ status: "done", comment: "Independently reviewed exact revision" });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(reviewed.body.status).toBe("done");
    expect((await f.svc.getById(f.issueId))?.completedAt).toBeTruthy();
    expect(reviewed.body.executionState.completedStageIds).toHaveLength(2);
    const receipts = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    expect(receipts).toHaveLength(2);
    expect(receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageType: "review", actorUserId: "reviewer", outcome: "approved" }),
      expect.objectContaining({ stageType: "approval", actorUserId: "board-user", outcome: "approved", body: expect.stringContaining(f.approvalId) }),
    ]));
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(2);
    // All participants are users: completion must not enqueue a spurious agent run.
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await approvalRecords(db).getById(f.approvalId)).toEqual(before);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toHaveLength(1);
  });
  it("consumes the same approved card after independent review without a second board decision", async () => {
    const f = await fixture();
    const before = await approvalRecords(db).getById(f.approvalId);
    const result = await f.svc.update(f.issueId, { ...f.review.patch, actorUserId: "reviewer" });
    expect(result?.status).toBe("done");
    expect((result?.executionState as any).completedStageIds).toHaveLength(2);
    expect(await approvalRecords(db).getById(f.approvalId)).toEqual(before);
    const receipts = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].body).toContain(f.approvalId);
    expect(receipts[0].actorUserId).toBe("board-user");
  });
  it.each(["company", "issue", "scope", "decider", "pending", "rejected"])("rejects %s mismatch atomically", async invalid => {
    const f = await fixture(invalid);
    await expect(f.svc.update(f.issueId, { ...f.review.patch, actorUserId: "reviewer" })).rejects.toMatchObject({ status: 422 });
    expect((await f.svc.getById(f.issueId))?.assigneeUserId).toBe("reviewer");
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(0);
  });
  it("rejects replay of a consumed review transition", async () => {
    const f = await fixture();
    await f.svc.update(f.issueId, { ...f.review.patch, actorUserId: "reviewer" });
    await expect(f.svc.update(f.issueId, { ...f.review.patch, actorUserId: "reviewer" })).rejects.toMatchObject({ status: 422 });
  });
});
