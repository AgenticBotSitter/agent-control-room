# CR12B-IDEA-100 owner-ready qualification and live-panel packet acceptance

**Status:** Superseded by the IDEA-105 reviewed-runtime refresh. The staged design remains accepted, but its earlier
authorization and digests cannot be reused. No native attempt or provider call occurred.

## Accepted staged packet

The immutable packet binds:

- Hermes Agent `0.21.0` at reviewed revision `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`, 60 commits after release
  revision `29112bef099274229cadff79cdff7bf7b99c4b77`;
- source-compatibility commit `c71de92dbce49ec1b8ae2af7977384c535d265fd`;
- exact reviewed source-manifest and sanitized source-preflight evidence from IDEA-105;
- admission implementation `2aa70fde1657b36a06303a744de736ec30624386`;
- filtered-driver implementation `0d61d8a2a2986c166885b5d7e97bcc7e2b5e09fc`;
- durable-authority implementation `db4b2e470213cd96284cbc201cdfde21a16f09c1`; and
- the exact panel packet and native-qualification plan digests.

The order cannot be collapsed:

1. One owner-attended, disposable, read-only native qualification may occur only after a fresh exact authorization. It
   permits one native attempt and one provider call in at most 300 seconds, retains at most 256 KiB sanitized evidence,
   exposes zero tools/MCP/plugins, writes nothing to the repository, uses Hermes-native protected-value custody, cleans
   the temporary profile/workspace, and never retries after uncertainty.
2. The sanitized result is only an unaccepted candidate. A different reviewer must bind the exact candidate digest, and
   a separate architect-key decision must add its receipt to the durable registry. The candidate cannot accept itself.
3. The first live Idea Lab panel needs an exact session and participants, the accepted receipt, a separately authorized
   fresh strong-factor owner window, the durable external high-water, and one sealed admission/window/run. The
   qualification window cannot be reused. Project creation remains another owner decision.

## Candidate receipt

The packet includes an exact sanitized candidate schema for qualified, definite-failure, and terminal-ambiguity outcomes.
Even a complete candidate fixes `independentReviewed`, `architectAccepted`, `livePanelEligible`, approval, and execution
authority to false. A qualified candidate requires one call; exact custody, replay, usage, interrupt/reconciliation, and
cleanup evidence digests; stopped process; removed disposable resources; and bounded retained evidence.

## Verification

- New packet/candidate hostile suite: 8/8 passed.
- Combined CR12B suite: 89/89 passed.
- The complete registered `npm test` lifecycle passed with zero failures.
- TypeScript, full repository lint, production build, whitespace validation, and macOS stage-zero readiness passed.
- All 3 rendered route checks passed, including Idea Lab and its promoted project workspace.
- All 31 migrations recreated and verified 109 PostgreSQL tables in the disposable verification database.
- Cases cover exact implementation pins, strict three-stage ordering, different owner windows, bounded candidate output,
  definite pre-provider failure, terminal cleanup ambiguity, cleanup/time/evidence drift, re-digested authority claims,
  Proxy rejection without traps, and absence of native/provider/deployment clients.

## Effects not performed

No Hermes process/profile/workspace, provider, protected value, Keychain, network, repository mutation outside this
implementation, production database/VPS, deployment, DNS, or hosting effect occurred. Default, browser, and production
composition remain provider-disabled; the local pilot remains repository-fake only.

## Next gate

IDEA-110 is an owner-attended native qualification, not an automatic build step. It may begin only after both refreshed
commits are integrated and the owner gives the exact fresh authorization in `CR12B_IDEA_105_OWNER_AUTHORIZATION.md`.
A qualified result still cannot start a live
panel; independent review, architect registry acceptance, an exact Idea Lab session, and a second owner window come next.
