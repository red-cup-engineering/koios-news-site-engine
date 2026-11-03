# Scoped native website receiving

## Requirements and specification

Preserve original sealed candidate verification, pinned Wrangler, release binding, preview admission/deployment, representative route probes, rollback binding, production baseline, authority-use records, deployment readback, exact public bytes, original immutable receipts and failure diagnostics. No new account, signing identity, authority journal, release retry or paid capacity is introduced.

The named scoped release requires explicit original account environment, owner staging and a private active checkpoint. Keep credentials local to that snapshot. Check pending resource custody before/after provider commands and awaited reads, and before authority consumption, receipts, rollback records, diagnostics or cleanup. Lost custody cannot launch cleanup, consume more authority, record success or trigger another deployment. A submitted command whose return is uncertain stays subject to the original provider readback and authority-use reconciliation; checkpoint checks alone are not remote atomic fencing.

## Design

The existing release implementation accepts private environment/checkpoint/staging options; `releaseWebsiteScoped` requires them explicitly while the original entry retains native compatibility defaults. Original carrier functions gain active checkpoint support at their existing command and receipt boundaries. The release observer checks each stage and cleanup, and preserves a custody failure together with an ordinary provider failure. Selected environment reaches Wrangler, rollback observations and diagnostic redaction. Native temporary command configuration lives under the owner-selected staging root for scoped calls.

Before returning a successful release, read back the original `release.json` or `already-live-audit.json` immutable receipt and require its exact candidate manifest and accepted public probe. Return that original receipt path, never create a replacement receipt ledger. Koios's fixed authenticated resource granules use CSE's original signed actor receiver and pending reservation guard; its durable signed reply is the transport receipt only after original website receiving completes.

Source cases cover environment propagation, lost custody preventing later provider calls/authority writes/cleanup and original receipt readback. No applications, builds, provider calls or tests are executed under this source-only task. Source qualification, complete original state admission, exact release composition and deployment are outstanding.
