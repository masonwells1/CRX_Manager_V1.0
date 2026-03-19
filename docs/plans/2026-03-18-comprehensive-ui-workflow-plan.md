# Comprehensive UI Workflow E2E Test — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a single serial Playwright E2E test covering the complete business lifecycle (Quote→Order→Delivery→Returns→Financials→Commissions) through UI interactions with inventory/financial verification between each step.

**Architecture:** One test file with 12 acts (~160 steps), shared state object, verification helpers using Supabase REST API, and full cleanup on completion.

**Tech Stack:** Playwright, TypeScript, Supabase REST/RPC helpers

---

## Task 1: Write the test file with Acts 1-3 (Baseline + Quote + Convert to Order)

**Files:**
- Create: `tests/e2e/comprehensive-ui-workflow.spec.ts`

Steps: Write Acts 1-3 (~40 steps), run, fix any issues.

## Task 2: Write Acts 4-5 (Edit Order + Partial Delivery)

Steps: Add Acts 4-5 (~30 steps), run from Act 4 onward, fix issues.

## Task 3: Write Acts 6-7 (Cancel Partial + Deliver Remaining)

Steps: Add Acts 6-7 (~20 steps), run, fix issues.

## Task 4: Write Acts 8-9 (Invoice + Payment)

Steps: Add Acts 8-9 (~20 steps), run, fix issues.

## Task 5: Write Acts 10-11 (Returns + Commission Payment)

Steps: Add Acts 10-12 (~30 steps), run, fix issues.

## Task 6: Write Act 12 (Final Reconciliation + Cleanup)

Steps: Add cleanup and final verification, run full suite.

## Task 7: Full Clean Run

Run entire test from beginning to end. Fix any regressions. Run again if fixes were needed.

## Task 8: Git Push

Commit all changes and push to main. Run any needed Supabase migrations.
