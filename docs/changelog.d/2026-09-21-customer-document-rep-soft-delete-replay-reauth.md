## 2026-09-21 - soft_delete_customer_document: a retry is re-checked against the current assignment

Codex `gpt-5.6-luna` xhigh review, round 1, of the parked
`20260921180000_soft_delete_customer_document_rpc.sql`.

**Fixed (BLOCKER).** A same-key retry returned the stored receipt before the assignment check. So a
rep whose customer had since been reassigned could still read the receipt, which names the
customer. A rep's retry is now honoured only while that customer is still assigned to them;
otherwise it gets the same `CUSTOMER_DOCUMENT_NOT_FOUND` as any other rep. The prover now proves
two things: the refusal after reassignment, and the successful retry after the customer is
assigned back. It also skips PR #761's parked `20260914100450` once that file reaches disk.

**Fixed (MED, page PR).** Before logging activity, the Remove button requires the server to
confirm both the clicked document and this page's customer.

**Refuted.**
- *(HIGH) "the page can deploy before the function exists"*: the page change is a separate PR that
  merges only after the apply, and `rpcFixtureLiveDiff.test.ts` blocks it until then.
- *(HIGH) "a rep's UPDATE without RETURNING would succeed"*: running it on the rebuilt real schema
  is refused with `new row violates row-level security policy`, the same as live.

**Deferred (LOW).** The proof image is pinned by tag, not digest. Every other real-schema prover in
the repo does the same, and nothing here claims a digest pin.

**Side finding, sized.** A read-only live query on 2026-09-21 shows `authenticated` holds TRUNCATE
on 109 of 160 public tables, not only on `customer_documents`. It is flagged for a separate task.
