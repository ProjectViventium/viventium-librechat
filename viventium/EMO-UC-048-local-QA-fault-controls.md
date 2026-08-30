# EMO-UC-048 local-QA fault controls

Status: source support only. This document does not mean that installed QA is configured or run.

## Safety contract

The four controls are disabled unless the API process has both values:

- `VIVENTIUM_LOCAL_QA_MODE=emo_uc_048`
- `VIVENTIUM_LOCAL_QA_CASE_TOKEN=<one fresh 32-byte-or-longer base64url token>`
- `VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST=<sha256: plus 64 lowercase hex characters>`

The token is for one QA run. Do not put it in command arguments, logs, fixture text, or source files.
The control stores only its SHA-256 hash. Each control is atomic, one-shot, restart-safe, and limited
to 1 through 3,600 seconds. Its redacted audit row remains for 24 hours after expiry, then MongoDB
can remove it with the TTL index.

Arm is fail-closed. The caller cannot assert that a scope is synthetic. LibreChat first verifies the
exact owner, conversation, and parent against all three durable fixture rows below. Ordinary,
expired, malformed, wrong-token, and cross-owner rows do not pass.

## Durable synthetic fixture contract

The installed parent fixture provisioner must create all three rows before it calls `arm`. Use
fresh random namespace suffixes for every run. The fixture expiry must be at or after the requested
control expiry.

Define these hashes without writing raw values to logs:

```text
caseTokenHash       = "sha256:" + SHA256("case-token\0" + caseToken)
ownerScopeHash      = "sha256:" + SHA256("owner\0" + ownerId)
conversationScopeHash = "sha256:" + SHA256("conversation\0" + conversationId)
parentScopeHash     = "sha256:" + SHA256("parent\0" + parentMessageId)
```

Required rows:

1. `User`
   - `_id` is the scoped owner ID.
   - `provider` is `viventium_local_qa_fixture`.
   - `email` matches `emo-uc-048-<32 lowercase hex>@local-qa.invalid`.
   - `idOnTheSource` is `viventium:local-qa:emo_uc_048:<caseTokenHash>`.
   - `expiresAt` covers the control expiry.
2. `Conversation`
   - `user` is the same owner ID.
   - `conversationId` matches `emo_uc_048_conversation_<32 lowercase hex>`.
   - `tags` contains `viventium:local-qa:emo_uc_048` and the exact `caseTokenHash`.
   - `expiredAt` covers the control expiry.
3. Parent `Message`
   - `user` and `conversationId` match the same fixture rows.
   - `messageId` matches `emo_uc_048_parent_<32 lowercase hex>`.
   - `isCreatedByUser` is not `true`.
   - `expiredAt` covers the control expiry.
   - `metadata.viventium.localQaFixture` contains exactly the current `schemaVersion: 1`,
     `caseId: "emo_uc_048"`, `componentArtifactDigest`, all four hashes above, and an `expiresAt`
     that covers the control. `componentArtifactDigest` must exactly equal
     `VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST` in the current LibreChat process.

Use synthetic content only. Do not copy prompts, customer content, real owners, real conversations,
or real parent messages into these fixtures.

## Stable CLI interface

Run this from the installed LibreChat root:

```text
node scripts/viventium-cortex-fault-control.js <arm|query|clear> \
  <--scope-fd <private-fd> | --scope-file <0600-file>> [--json]
```

Exactly one explicit private input channel is required. Redirected stdin is rejected because its
privacy cannot be proved portably. `--scope-fd` accepts descriptors 3 through 1024 and checks that
the descriptor is owner-only. `--scope-file` rejects symlinks, non-files, files owned by another
user, and group/world permissions. Input is limited to 8 KiB. Raw owner, conversation, and parent
IDs are not accepted in command arguments.
After reading the private document, the CLI also rejects a file path or other argument that embeds
one of those exact IDs.

Arm input:

```json
{
  "schemaVersion": 1,
  "scope": {
    "ownerId": "<durable synthetic owner ID>",
    "conversationId": "emo_uc_048_conversation_<32 lowercase hex>",
    "parentMessageId": "emo_uc_048_parent_<32 lowercase hex>"
  },
  "boundary": "telegram_promoted_parent_presentation",
  "ttlSeconds": 60
}
```

`query` and `clear` use the same document. They permit an optional `boundary` and reject
`ttlSeconds`. Supported boundaries are:

- `cortex_ledger_first_write`
- `web_replay_persistence`
- `web_redis_publish_ack`
- `telegram_promoted_parent_presentation`

The parent hookup should create a `0600` temporary input file or inherited private descriptor,
write the document without printing it, then invoke the command. For example, after descriptor 3
is already open on a private file:

```text
node scripts/viventium-cortex-fault-control.js arm --scope-fd 3 --json
node scripts/viventium-cortex-fault-control.js query --scope-fd 3 --json
node scripts/viventium-cortex-fault-control.js clear --scope-fd 3 --json
```

Standard output contains control IDs, boundary names, state, timestamps, audit event names, counts,
and scope hashes only. Standard error contains a typed error code only. The CLI rejects service
output if any raw scoped ID appears in it.

## Installed parent lifecycle still required

The parent installer/CLI must still do these steps outside this repository:

1. Generate the per-run token and fresh synthetic fixture namespace.
2. Provision the three durable fixture rows through an authorized local database path.
3. Put the mode, token, and exact component artifact digest in the installed API process
   environment and restart that process.
4. Invoke this CLI through a private input channel for arm, query, and clear.
5. Clear unused controls, remove only the exact synthetic fixture rows, remove the mode and token,
   and restart the API process.

Do not report installed QA until that parent hookup and the installed runtime path are tested.
