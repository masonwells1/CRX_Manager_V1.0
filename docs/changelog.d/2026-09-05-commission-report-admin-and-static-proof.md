## 2026-09-05 - Harden commission history access and proof restoration

- Hide the admin-only commission balance history tab from sales representatives and defensively prevent its RPC and exports after an in-session role downgrade.
- Restore disposable commission-date proof fixtures only from the reviewed on-disk migration source, never from catalog-derived executable DDL.
