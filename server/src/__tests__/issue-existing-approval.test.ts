import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, companyMemberships, createDb, issues, issueExecutionDecisions } from "@paperclipai/db";
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
  async function fixture(invalid?: string) {
    const companyId = randomUUID(), issueId = randomUUID(), approvalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Approval test", issuePrefix: `P${companyId.slice(0, 7)}` });
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
    const initial = (await svc.getById(issueId))!;
    const start = applyIssueExecutionPolicyTransition({ issue: initial, policy, requestedStatus: "done", requestedAssigneePatch: {}, actor: { userId: "executor" }, commentBody: "Ready for independent review" });
    await svc.update(issueId, { ...start.patch, actorUserId: "executor" });
    const pending = (await svc.getById(issueId))!;
    expect(pending.status).toBe("in_review");
    expect(pending.assigneeUserId).toBe("reviewer");
    const review = applyIssueExecutionPolicyTransition({ issue: pending, policy, requestedStatus: "done", requestedAssigneePatch: {}, actor: { userId: "reviewer" }, commentBody: "Independently reviewed exact change" });
    return { svc, issueId, approvalId, review };
  }
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
