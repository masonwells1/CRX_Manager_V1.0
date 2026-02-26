# QA Testing Methodology

## Role-Based Testing Matrix

Test every feature as each role:

| Feature | Admin | Sales Rep | Driver | Applicator |
|---------|-------|-----------|--------|------------|
| Dashboard KPIs | Full view | Full view | Deliveries only | Jobs only |
| Products CRUD | Full | Read only | No access | Read only |
| Customers CRUD | Full | Own assigned | Via delivery only | Read only |
| Quotes CRUD | Full | Own only | No access | No access |
| Orders CRUD | Full | Create/Read | No access | No access |
| Inventory | Full | Read + holds | Read only | No access |
| Deliveries | Full | Create/Edit/Cancel | Own + confirm/complete/photos/issues/quick delivery | No access |
| Purchase Orders | Full | Read/Receive | No access | No access |
| Blend Tickets | Full | Upload/review | No access | No access |
| Jobs | Full | Create/Edit | No access | Own assigned + record applied info |
| Vehicles | Full | Read only | No access | Read only |
| Application Records | Full | Read | No access | Read |
| Invoices | Full | Read/Create | No access | No access |
| Payments | Full | Read/Create | No access | No access |
| Month-End Close | Full | No access | No access | No access |
| Commission Payments | Full | No access | No access | No access |
| Fields | Full | Own customer | No access | Read only |
| Reports | Full | Limited | No access | No access |
| Team Board | Full (own notes) | Full (own notes) | Full (own notes) | Full (own notes) |
| Settings | Full | No access | No access | No access |

## Workflow End-to-End Tests

### Quote to Delivery
1. Create customer with tier assignment
2. Create quote with product sections
3. Send quote (status -> sent)
4. Accept quote (status -> accepted)
5. Convert to order (creates order + order_items + commissions)
6. Create delivery from order
7. Assign driver
8. Confirm/start delivery (scheduled -> in_progress, inventory check warning)
9. Complete delivery (updates inventory, order fulfillment, creates remainders for partial)
10. Record payment (updates order balance_due)

### Quick Delivery (ad-hoc)
1. Open Quick Delivery modal (from Deliveries page or driver dashboard)
2. Search/select customer
3. Add products with quantities
4. Optionally assign driver, set date, add notes
5. Submit -> creates order + delivery + draft invoice atomically
6. Sales rep reviews and posts the draft invoice

### Purchase Order to Inventory
1. Create PO with product items
2. Submit PO (status -> submitted)
3. Receive partial shipment (updates PO item, inventory, cost if changed)
4. Receive remaining (PO -> fully_received)
5. Verify inventory levels updated
6. Verify cost_history created if cost changed

## Edge Case Testing
- Negative inventory (receive more than expected)
- Expired quotes (auto-expire logic)
- Zero-quantity orders
- Commission splits that don't sum to 100%
- Concurrent hold creation exceeding available inventory
- Bulk imports with invalid data
- PDF generation with very long product names
- Delivery for cancelled order
