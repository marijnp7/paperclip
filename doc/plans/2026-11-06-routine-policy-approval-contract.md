# Optional routine policy and existing board approval

Status: draft for independent review. Do not deploy from this document.

## Routine contract

Create and update accept optional `executionPolicy`, using the issue policy schema.
Omission on update retains the locked current value. `null` clears it. Create without
it stores null. Revisions include the normalized policy. Restore of an old snapshot
without the field restores null. Dispatch passes the saved policy into issue creation.
No policy is inferred from risk, labels, or routine names. Existing concurrency and
revision guards remain in force.

## Existing approval contract

An approval stage can carry:

```json
{
  "type": "approval",
  "participants": [{ "type": "user", "userId": "the-actual-board-decider" }],
  "existingApproval": {
    "approvalId": "uuid-of-existing-approved-card",
    "scope": "exact-scope-from-approved-payload"
  }
}
```

The existing approval record must be approved, have a decision timestamp, belong
to the same company, and name this exact user in `decidedByUserId`. Its approved
`payload.scope` must equal the reference scope. Its approved `payload.issueIds`
must contain the current issue UUID. A mutable issue link or parent relationship
does not extend the approved scope. Cards without this explicit scope fail closed;
this contract does not modify old cards or authorize a new board decision.

The preceding stage must be an independent review. Consumption occurs under the
issue row lock in the update transaction, with a shared lock on the approval row.
The policy must remain unchanged. The caller must be the recorded reviewer and
must differ from the recorded executor. The server adds an execution decision
receipt naming the original card and timestamp. It does not change the approval
or submit another approval request. Replays are rejected. Client supplied completed
stage IDs are not part of the API contract. The UI policy editor preserves the
reference when retaining the approval stage.

## Deploy and rollback plan

Owner: integration DevOps engineer, after independent CTO review of the exact SHA.
This draft author does not approve the change.

1. Complete targeted service and HTTP workflow tests and required CI. Integrate the
   policy helper against the contract above. Check the deployed source base against
   the fork base before merging; the fork default branch is `master`.
2. Record the current application image digest and source SHA. Build the reviewed
   revision. Apply only the additive routine JSONB migration through the normal
   reviewed deployment process. Do not activate routine policies yet.
3. Verify health, legacy routine dispatch without a policy, explicit policy dispatch,
   revision restore, and approved-card consumption on an isolated test company.
4. Have each routine owner apply the reviewed explicit policy. Record generated
   issue policies and the independent review receipt. Do not bypass routine ownership.
5. On failure, stop activation and have the integration owner restore the prior
   application image using the existing rollback runbook. Restore each affected
   routine's saved previous configuration through its owner. Retain the nullable
   column and revision history; no DROP or production data deletion is needed.
   Verify health and legacy dispatch after rollback. Measure rollback time during
   the rollout rehearsal; this draft has not demonstrated the two-minute target.

## Verification limitations

No production deploy, migration or routine configuration change was performed.
The standard server typecheck is blocked before TypeScript by missing `cargo` in
this workspace. Full workspace build and CI are not certified by this draft.
