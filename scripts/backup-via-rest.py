#!/usr/bin/env python3
"""
Dumps every table in the `public` schema to JSON files via PostgREST.
Reads the service_role key from backups/.svc.tmp, then deletes that file.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

PROJECT_REF = "rhyzpcqhnizqbxphqdkr"
BASE_URL = f"https://{PROJECT_REF}.supabase.co/rest/v1"
KEY_FILE = Path("backups/.svc.tmp")
OUT_DIR = Path("backups/2026-05-08")
PAGE_SIZE = 1000  # PostgREST default max — paginate above this

TABLES = [
    "accounting_periods", "activity_feed", "allocation_sets", "app_settings",
    "application_record_fields", "application_records", "application_services",
    "applicator_licenses", "ar_reminder_tracking", "blend_recipe_items",
    "blend_recipes", "blend_ticket_fields", "blend_ticket_images",
    "blend_ticket_products", "blend_ticket_to_order_items", "blend_tickets",
    "commission_payment_items", "commission_payments", "commissions",
    "cost_history", "customer_addresses", "customer_application_rates",
    "customers", "cycle_count_items", "cycle_counts", "deliveries",
    "delivery_items", "delivery_photos", "delivery_remainders",
    "email_log", "failed_notifications",
    "field_app_location_shares", "field_app_locations",
    "field_billing_defaults", "field_crop_history", "field_polygons", "fields",
    "finance_charges", "financial_audit_log", "idempotency_keys",
    "ingredient_map", "inventory", "inventory_holds", "inventory_transactions",
    "invoice_items", "invoice_line_allocations", "invoice_shares", "invoices",
    "job_applied_info", "job_chemicals", "job_fields", "jobs",
    "note_activity_log", "note_tags", "notifications", "ocr_processing_queue",
    "order_items", "order_line_allocations", "order_shares", "orders",
    "payments", "prepay_applications", "prepay_credits", "products", "profiles",
    "purchase_order_items", "purchase_orders", "quote_items",
    "quote_pdf_templates", "quote_sections", "quote_templates",
    "quote_versions", "quotes", "rate_limit_log", "rate_limits",
    "rebate_claims", "rebate_programs", "receiving_photos", "receiving_records",
    "return_items", "returns", "rup_sales_records", "team_note_attachments",
    "team_note_comments", "team_note_tags", "team_notes", "unit_conversions",
    "vehicles", "vendor_bills", "vendor_payments", "vendors", "warehouses",
    "write_offs",
]


def fetch_table(name: str, key: str) -> list[dict]:
    """Page through a single table until exhausted."""
    rows: list[dict] = []
    offset = 0
    while True:
        url = f"{BASE_URL}/{name}?select=*&offset={offset}&limit={PAGE_SIZE}"
        req = urllib.request.Request(url, headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Range-Unit": "items",
        })
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                page = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"{name}: HTTP {e.code} — {body}") from None
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return rows


def main() -> int:
    if not KEY_FILE.exists():
        print(f"ERROR: {KEY_FILE} not found. Save the service_role key there first.",
              file=sys.stderr)
        return 1

    key = KEY_FILE.read_text(encoding="ascii").strip()
    if not key.startswith("eyJ"):
        print("ERROR: file content doesn't look like a JWT", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest: dict = {
        "project_ref": PROJECT_REF,
        "dumped_at": datetime.now(timezone.utc).isoformat(),
        "tables": {},
    }

    started = time.time()
    for i, t in enumerate(TABLES, 1):
        t0 = time.time()
        try:
            rows = fetch_table(t, key)
        except Exception as exc:
            print(f"[{i:2}/{len(TABLES)}] {t:<40} FAIL — {exc}")
            manifest["tables"][t] = {"rows": None, "error": str(exc)}
            continue
        path = OUT_DIR / f"{t}.json"
        path.write_text(json.dumps(rows, indent=2, default=str), encoding="utf-8")
        bytes_written = path.stat().st_size
        manifest["tables"][t] = {"rows": len(rows), "bytes": bytes_written}
        print(f"[{i:2}/{len(TABLES)}] {t:<40} {len(rows):>5} rows  "
              f"{bytes_written:>9,} B  ({time.time() - t0:0.2f}s)")

    manifest["elapsed_seconds"] = round(time.time() - started, 2)
    (OUT_DIR / "_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8")

    # Wipe the credential file
    try:
        KEY_FILE.unlink()
        print(f"\nDeleted {KEY_FILE}")
    except Exception as e:
        print(f"WARN: could not delete {KEY_FILE}: {e}")

    total_rows = sum(
        v.get("rows") or 0 for v in manifest["tables"].values())
    total_bytes = sum(
        v.get("bytes") or 0 for v in manifest["tables"].values())
    print(f"\nDone in {manifest['elapsed_seconds']}s — "
          f"{total_rows:,} rows across {len(TABLES)} tables, "
          f"{total_bytes:,} bytes total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
