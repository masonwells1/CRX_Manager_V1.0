## 2026-09-03 - Bind commission history lineage and first-apply ACL

- Bind the two reviewed live legacy cancellations to a non-reversible identity digest verified
  read-only on 2026-09-03; accept zero only while the commission subsystem is a clean rebuild.
- Mutation-test removal, dating, and identity replacement against a synthetic two-row lineage.
- Check the existing report and private void-helper ACL before their first replacement, so first apply
  cannot silently normalize an anonymous or unexpected direct grant.
