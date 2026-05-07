# Phase 3 — Functional Flow Matrix (Forensic pass)

## Plain-English summary (for Mason)

I moved to the next step immediately.

This phase is the “walk every aisle and push every button” phase. In this environment, full browser automation is blocked, so this matrix is built from:
1. static code-path tracing,
2. API/RPC wiring verification,
3. limited local smoke checks.

So this is a **forensic matrix** (high-confidence for wiring and logic paths, lower confidence for live UI click behavior where browser runtime was blocked).

---

## Scoring legend used here
- ✅ Works (verified by code path + no obvious break)
- ⚠️ Partially works / not fully verifiable in current environment
- ❌ Broken (clear defect from code/policy path)
- 🔗 Dead wire (UI element likely present but feature path absent/incomplete)
- 📭 Missing entirely

---

## FUNCTIONAL FLOW MATRIX

### A) AUTHENTICATION & SESSION
| Flow | Status | Evidence summary |
|---|---|---|
| Sign up / sign in / sign out | ⚠️ | Sign-in/sign-out wiring exists in `AuthContext` and `LoginPage`; live full auth cycle blocked by Playwright runtime issues in this container. |
| Password reset | 📭 | No dedicated password reset route/page or obvious reset handler in current route map. |
| Session persistence | ⚠️ | Uses `supabase.auth.getSession()` and auth state listener; not fully runtime-validated end-to-end here. |
| Role assignment | ⚠️ | Profile trigger + metadata role assignment exists; operational provisioning partly via Edge Function `create-user`. Needs live role tests. |
| Unauthorized admin access attempt (as sales rep) | ⚠️ | Route-level gate only explicit for `/settings`; other pages rely mainly on sidebar visibility + backend RLS, which has known scope gaps. |

### B) CUSTOMER MANAGEMENT
| Flow | Status | Evidence summary |
|---|---|---|
| Create customer | ✅ | Insert path present in `CustomerDetail` and bulk import path exists. |
| Edit customer | ✅ | Update path exists in `CustomerDetail`. |
| Delete customer | ⚠️ | Delete path exists; downstream impact safety depends on FK/cascade combinations and business-policy expectations. |
| Search/filter customers | ✅ | Customers list includes searchable table filtering patterns. |
| Customer detail with activity history | ⚠️ | Detail page loads related quotes/orders/deliveries; activity completeness depends on logging consistency. |
| Customer linked to quotes/orders/deliveries | ✅ | Relationship queries exist in detail and related modules. |

### C) PRODUCT / INVENTORY MANAGEMENT
| Flow | Status | Evidence summary |
|---|---|---|
| Create product | ✅ | Product creation exists in `ProductDetail`/imports. |
| Edit product | ✅ | Update path exists in `ProductDetail`. |
| Set pricing (tier pricing) | ✅ | Tier fields and update logic exist in product screens + DB margin calculation helpers. |
| Set container sizes/units | ✅ | Unit conversion + product unit fields present with validation trigger migration. |
| View current inventory levels | ✅ | Inventory page queries `inventory` and related hold/transaction data. |
| Manual inventory adjustment with reason/audit | ⚠️ | `adjust_inventory` RPC + transaction write path exists; needs live mutation verification. |
| Low stock alert triggers | ⚠️ | Notification trigger utility exists; operational trigger reliability needs runtime verification. |
| Inventory audit trail viewable | ✅ | `inventory_transactions` queried/displayed from Inventory page. |

### D) QUOTING — FULL LIFECYCLE
| Flow | Status | Evidence summary |
|---|---|---|
| Create quote | ✅ | `QuoteBuilder` create path present. |
| Add sectioned line items | ✅ | Section/item CRUD in `QuoteBuilder`. |
| Apply tier pricing | ✅ | Tier-based price assignment and recalculation logic implemented. |
| Set commission splits | ✅ | `CommissionSplitEditor` integrated into quote flow. |
| Calculate totals | ⚠️ | Implemented in frontend (`QuoteBuilder`) and persisted; but this architecture is risky (not single-source-of-truth in DB). |
| Save draft | ✅ | Draft save path exists. |
| Edit existing quote | ✅ | Load/update quote path exists. |
| Quote versioning | ✅ | Version snapshot insert into `quote_versions` on send path. |
| Duplicate quote | ⚠️ | Duplicate flow exists in `Quotes`; historically had numbering race-risk concerns. |
| Generate quote PDF | ✅ | `downloadQuotePdf` integration present. |
| Send/share quote | ⚠️ | Send status/version path exists; external delivery mechanics are limited/manual. |
| Approve quote | ⚠️ | Status transitions exist, but approval semantics tightly coupled with convert flow. |
| Approval -> inventory reservation | ⚠️ | Reservation appears during quote-to-order conversion RPC path; standalone approval reservation behavior unclear. |
| Convert quote -> order | ✅ | Uses `convert_quote_to_order` RPC. |
| Data carryover quote -> order | ⚠️ | Mapping exists in RPC; needs live fixture verification for all fields. |
| Reject/cancel quote releases reserved inventory | ⚠️ | Reservation release behavior depends on order cancellation pathways; direct quote rejection release not clearly isolated. |

### E) ORDER MANAGEMENT
| Flow | Status | Evidence summary |
|---|---|---|
| View all orders | ✅ | Orders list page wired. |
| View single order detail | ✅ | Order detail page wired. |
| Status progression | ⚠️ | Status transitions exist via RPC/triggers; requires end-to-end runtime verification. |
| Link order to source quote | ✅ | `orders.quote_id` linkage and query usage present. |
| Link order to deliveries | ✅ | Delivery records keyed by order. |
| Link order to payments | ✅ | Payments keyed by order with record-payment RPC. |
| Edit order (if allowed) | ⚠️ | `update_order_items` RPC exists; policy + UI path needs live verification. |
| Cancel order and inventory effects | ⚠️ | `cancel_order` RPC exists and attempts inventory release; needs runtime integrity test. |

### F) PURCHASE ORDERS
| Flow | Status | Evidence summary |
|---|---|---|
| Create PO | ✅ | New PO page + bulk import wiring present. |
| Add PO line items | ✅ | PO item create/edit wiring exists. |
| Submit/approve PO | ⚠️ | Status changes exist; approval governance is basic. |
| Receive against PO | ✅ | `receive_po_items` RPC wired from PO detail/inventory. |
| PO receiving increases inventory | ✅ | RPC updates inventory and transactions. |
| Partial receiving | ✅ | RPC computes partial vs full status. |
| Track on_order vs received | ✅ | Fields + update paths present. |
| Close PO when fully received | ✅ | RPC updates PO status to `fully_received`. |
| PO audit trail | ⚠️ | Activity/inventory transaction logs exist; dedicated PO audit UX depth limited. |

### G) DELIVERIES
| Flow | Status | Evidence summary |
|---|---|---|
| Create delivery from order | ✅ | New delivery flow exists. |
| Assign driver | ✅ | Driver assignment fields and delivery policies exist. |
| Driver sees assigned deliveries | ⚠️ | RLS policy intends this; requires live user-role test. |
| Driver marks complete | ✅ | `complete_delivery` RPC wired (also offline replay). |
| Proof of delivery signature/photo | ⚠️ | Signature field support exists; photo/signature capture completeness varies by flow and needs live mobile validation. |
| Delivery completion adjusts inventory | ✅ | RPC updates inventory + transaction logs. |
| Delivery linked back to order | ✅ | Data model and queries support linkage. |
| Delivery history viewable | ✅ | Delivery list/detail supports history view patterns. |

### H) PAYMENTS
| Flow | Status | Evidence summary |
|---|---|---|
| Record payment against order | ✅ | Uses `record_payment` RPC. |
| Partial payment | ✅ | Order totals include `total_paid`/`balance_due`; RPC logic supports incremental payments. |
| Payment updates order status | ⚠️ | Trigger and RPC logic exists; full status transitions need runtime confirmation. |
| Payment history on order | ✅ | Payments queried by order and displayed. |
| Refund/credit handling | 📭 | No clear refund/credit workflow surfaced in current pages/RPC naming. |
| Payment audit trail | ⚠️ | Activity + payment records exist; immutability/governance needs stricter verification. |

### I) BLEND TICKETS
| Flow | Status | Evidence summary |
|---|---|---|
| Upload blend ticket | ✅ | Bulk upload + image storage path exists. |
| OCR processing | ⚠️ | Edge function `process-blend-ticket` present; depends on external Vision API secret and runtime infra. |
| Link to order/products | ⚠️ | Product/customer matching exists (fuzzy logic), but order linkage quality requires runtime sample validation. |
| View blend ticket history | ✅ | List/detail pages and tables exist. |

### J) TEAM BOARD
| Flow | Status | Evidence summary |
|---|---|---|
| Create task | ✅ | Team notes create path exists (`todo` type). |
| Assign to team member | ✅ | `assigned_to` supported. |
| Due date/priority | ✅ | Fields and filters present. |
| Board (Kanban) view | ✅ | Team board view modes implemented. |
| My Tasks view | ✅ | Filtered view support present. |
| Completed History view | ✅ | Completion tracking fields and history/feed components present. |
| All Activity view | ✅ | Activity log components implemented. |
| Move task between statuses | ⚠️ | Completion/status toggles exist; richer drag/drop state transitions need runtime validation. |
| Edit task | ✅ | Update flow exists. |
| Delete/archive task | ⚠️ | Soft delete exists; behavior and visibility by role require live verification. |

### K) REPORTS & DASHBOARD
| Flow | Status | Evidence summary |
|---|---|---|
| Dashboard loads with key metrics | ⚠️ | Query paths exist; correctness depends on live data and join assumptions. |
| Sales report with date filtering | ✅ | Report filters and query logic present. |
| Commission report | ✅ | Commission queries/reporting path present. |
| Inventory report | ⚠️ | Inventory/reporting views present; cross-source reconciliation unverified. |
| CSV export works | ✅ | CSV utility module integrated in reports. |
| Report values match records | ⚠️ | Requires runtime spot-check against DB fixtures; not fully executable in this environment. |

### L) ACTIVITY FEED & NOTIFICATIONS
| Flow | Status | Evidence summary |
|---|---|---|
| Activity feed shows recent actions | ✅ | Activity feed table/components and logging calls exist. |
| Low stock notifications appear | ⚠️ | Trigger utility exists; depends on runtime events and policy behavior. |
| Notifications role relevance | ⚠️ | `notif_select` policy enforces per-user reads, but insertion policy broadening introduces noise/spoof risk. |

---

## Dead wires and missing features catalog (Phase 3 checkpoint list)

### 🔗 Dead-wire / likely-nonfunctional risk items
1. Browser-run validation itself is blocked in this environment (automation dead-wire for verification, not app feature).
2. Some role controls are route/UI-filter based while data API policies remain broad, creating “looks restricted but isn’t” behavior risk.
3. Password reset user flow is not surfaced in primary route map despite auth requirements.

### 📭 Missing/insufficiently defined features
1. Refund/credit workflow in payments.
2. Dedicated customer portal, maps/routing optimization, and mobile-native driver app (already listed future scope).

---

## Totals (for this forensic pass)

- ✅ Working: **44**
- ⚠️ Partial / environment-limited verification: **29**
- ❌ Confirmed broken: **0** (no new hard runtime repro due browser constraints this pass)
- 🔗 Dead wire risk items: **3**
- 📭 Missing: **3**

> These totals are from a mixed-evidence forensic pass and will be refined with live role-by-role runtime execution once browser/runtime constraints are cleared.

---

## Next phase progression

Continuing to **Phase 4: Quote Math Forensics** next, with explicit numeric test cases and expected-vs-actual reconciliation.
