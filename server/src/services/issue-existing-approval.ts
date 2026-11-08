import { and, eq } from "drizzle-orm";
import { approvals, issueExecutionDecisions, type Db } from "@paperclipai/db";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { unprocessable } from "../errors.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";

/** Called only inside the issue update transaction, after locking the issue. */
export async function consumeExistingStageApproval(
  tx: Db,
  issue: { id: string; companyId: string; executionPolicy: unknown; executionState: unknown; status: string },
  patch: Record<string, any>,
  actor: { agentId?: string | null; userId?: string | null },
) {
  const policy = normalizeIssueExecutionPolicy(patch.executionPolicy ?? issue.executionPolicy);
  let state = parseIssueExecutionState(patch.executionState);
  const stage = policy?.stages.find((entry) => entry.id === state?.currentStageId);
  if (!stage?.existingApproval || state?.status !== "pending") return;
  const previous = parseIssueExecutionState(issue.executionState);
  const reviewer = previous?.currentParticipant;
  const sameActor = reviewer?.type === "agent" ? reviewer.agentId === actor.agentId : reviewer?.userId === actor.userId;
  const executor = previous?.returnAssignee;
  const independent = reviewer && executor && (reviewer.type !== executor.type ||
    (reviewer.type === "agent" ? reviewer.agentId !== executor.agentId : reviewer.userId !== executor.userId));
  if (stage.type !== "approval" || previous?.status !== "pending" || previous.currentStageType !== "review" ||
    !sameActor || !independent || !previous.currentStageId || !state.completedStageIds.includes(previous.currentStageId) ||
    !isDeepStrictEqual(policy, normalizeIssueExecutionPolicy(issue.executionPolicy))) {
    throw unprocessable("Existing approval consumption requires an unchanged policy and an independent review decision");
  }
  const [approval] = await tx.select().from(approvals).where(and(
    eq(approvals.id, stage.existingApproval.approvalId), eq(approvals.companyId, issue.companyId),
  )).for("share");
  if (!approval || approval.status !== "approved" || !approval.decidedAt || !approval.decidedByUserId ||
    approval.payload.scope !== stage.existingApproval.scope ||
    !Array.isArray(approval.payload.issueIds) || !approval.payload.issueIds.includes(issue.id) ||
    !stage.participants.some((p) => p.type === "user" && p.userId === approval.decidedByUserId) ||
    state.currentParticipant?.type !== "user" || state.currentParticipant.userId !== approval.decidedByUserId) {
    throw unprocessable("Existing approval does not authorize this company, issue, scope and approver");
  }
  const body = `Consumed existing board approval ${approval.id} for scope ${stage.existingApproval.scope}; original decision ${approval.decidedAt.toISOString()}`;
  const result = applyIssueExecutionPolicyTransition({
    issue: { ...issue, ...patch, status: "in_review", executionPolicy: policy, executionState: state },
    policy, requestedStatus: "done", requestedAssigneePatch: {},
    actor: { userId: approval.decidedByUserId }, commentBody: body,
  });
  const decisionId = randomUUID();
  await tx.insert(issueExecutionDecisions).values({
    id: decisionId, companyId: issue.companyId, issueId: issue.id, stageId: stage.id,
    stageType: "approval", actorUserId: approval.decidedByUserId, outcome: "approved", body,
  });
  Object.assign(patch, { status: "done" }, result.patch);
  state = parseIssueExecutionState(patch.executionState)!;
  patch.executionState = { ...state, lastDecisionId: decisionId };
}
