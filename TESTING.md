# Testing Guide

This guide will walk you through testing the application. No coding experience needed!

## Quick Facts

| What | Where / when |
|--------|-------|
| **Unit tests** | Vitest `*.test.ts(x)` files next to the code in `src/`; `npm test` prints the current file and pass totals |
| **E2E specs** | Playwright specs in `tests/e2e/`. They run only against a staging Supabase project, and none exists yet, so they cannot run today (see [Running E2E Tests](#running-e2e-tests)) |
| **Pre-commit hook** | Fast checks on the files you staged (SQL and frontend validators, ledger and private-artifact checks). It does **not** run the build or the tests |
| **Pre-push hook** | Private-artifact containment, `npm run typecheck`, and `npm run build` — blocks the push if any fails |
| **CI (GitHub Actions)** | The full proof on every pull request that changes code: lint, typecheck, unit tests with coverage, build, documentation and SQL checks. This is the gate a change must pass before it can merge |

## Table of Contents
1. [Setting Up Your Computer](#setting-up-your-computer)
2. [Running the Application Locally](#running-the-application-locally)
3. [Running Unit Tests](#running-unit-tests)
4. [Running E2E Tests](#running-e2e-tests)
5. [Staging (not set up yet)](#staging-not-set-up-yet)
6. [Pre-Release Checklist](#pre-release-checklist)
7. [Troubleshooting](#troubleshooting)

---

## Setting Up Your Computer

Before you start, you need to install a few programs on your computer:

### 1. Install Node.js

Node.js is required to run the application.

1. Go to https://nodejs.org/
2. Download Node.js **24** — the version this project pins in its `.nvmrc` file
3. Run the installer and follow the instructions
4. To verify it's installed, open Terminal (Mac) or Command Prompt (Windows) and type:
   ```bash
   node --version
   ```
   You should see a version number starting with `v24`

### 2. Install Git

Git helps you download and manage the code.

1. Go to https://git-scm.com/downloads
2. Download the version for your operating system
3. Run the installer
4. To verify it's installed, type:
   ```bash
   git --version
   ```

### 3. Get Supabase Credentials

You'll need credentials from your Supabase project:

1. Go to https://supabase.com/dashboard
2. Log in to your account
3. Select your project
4. Click on "Settings" (gear icon in the left sidebar)
5. Click on "API" in the settings menu
6. You'll see:
   - **Project URL** (looks like: `https://xxxxxxxxxxxxx.supabase.co`)
   - **anon/public key** (a long string of characters)
7. Keep this page open - you'll need these values in the next section

---

## Running the Application Locally

Follow these steps to run the application on your own computer:

### Step 1: Download the Code

1. Open Terminal (Mac) or Command Prompt (Windows)
2. Navigate to where you want to store the project:
   ```bash
   cd Desktop
   ```
3. Clone the repository (replace with your actual repository URL):
   ```bash
   git clone YOUR_GITHUB_REPO_URL
   cd YOUR_PROJECT_FOLDER_NAME
   ```

### Step 2: Set Up Environment Variables

1. In the project folder, you'll see a file called `.env.example`
2. Make a copy of this file and name it `.env`:

   **On Mac/Linux:**
   ```bash
   cp .env.example .env
   ```

   **On Windows:**
   ```bash
   copy .env.example .env
   ```

3. Open the `.env` file in any text editor (TextEdit on Mac, Notepad on Windows)
4. Fill in your Supabase credentials from the previous section:
   ```
   VITE_SUPABASE_URL=https://xxxxxxxxxxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key-here
   ```
5. Save the file

### Step 3: Install Dependencies

This downloads all the code libraries the application needs:

```bash
npm install
```

This might take a few minutes. You'll see a lot of text scrolling by - that's normal!

### Step 4: Run the Development Server

Start the application:

```bash
npm run dev
```

You should see a message like:
```
  VITE ready in 500 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

Open your web browser and go to http://localhost:5173/

**Important:** Keep this terminal window open. When you want to stop the server, press `Ctrl+C`.

### Step 5: Verify It Works

1. You should see the login page
2. Try logging in with your credentials
3. If you can see the dashboard, everything is working!

If you see an error screen about missing environment variables:
- Check that your `.env` file exists
- Make sure the values are filled in correctly
- Restart the dev server (press `Ctrl+C` and run `npm run dev` again)

---

## Running Unit Tests

Unit tests check individual pieces of logic (calculations, PDF generation, data parsing, etc.) without needing a browser or database connection.

### Running All Unit Tests

```bash
npm test
```

This runs the full Vitest suite. File and pass totals come from the runner's own output rather than a hard-coded documentation count.

### Running Tests in Watch Mode

```bash
npm run test:watch
```

This keeps running and automatically re-tests when you save a file. Great during development.

### What Unit Tests Cover

- **PDF generation:** Quote, delivery, invoice, statement, receiving, year-end summary PDFs
- **Business logic:** Quote calculations, payment allocation, blend math validation
- **Data parsing:** OCR text parsing, field import (shapefile/KML/GeoJSON), CSV export
- **Permissions:** Page-level role access (admin/sales_rep/driver/applicator)
- **Offline support:** IndexedDB queue operations, sync logic
- **Utilities:** Unit conversions, idempotency keys, image compression
- **UI components:** SignatureCanvas, ActivityFeed, CommentsSection
- **Bulk and worksheet import:** BulkCustomerImport, BulkOrderImport, BulkProductImport, BulkPOImport, BulkQuoteImport, BulkTicketUpload, ManualTicketCreate, and the governed product-pricing `.xlsx` round trip

### What Runs Automatically

- **On every commit (pre-commit hook):** fast checks on the staged files only — the SQL and frontend validators, the ledger check, and the private-artifact containment check (plus agent-workflow and dependency checks when those files changed). It does **not** build the app or run the tests.
- **On every push (pre-push hook):** private-artifact containment, `npm run typecheck`, and `npm run build`. If any fails, the push is **blocked**.
- **On every pull request that changes code (CI):** lint, typecheck, the full unit-test suite with coverage, the build, and the documentation and SQL checks. Run `npm test` yourself before pushing if you want the test answer early.

The hooks live in the tracked `.husky/` folder. See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#pre-commit-checks) for the full list.

---

## Running E2E Tests

E2E (end-to-end) tests open a real browser and test the full application — login, creating records, navigating pages, etc.

### What Do These Tests Check?

- **Login/Logout:** Can users log in and out?
- **Customer Management:** Can you create, view, and search for customers?
- **Permissions:** Can users access the pages they're supposed to?
- **Every page:** Each lazy-loaded page is covered by the page-loading/basic-functionality inventory

### Before You Can Run Them

**E2E tests cannot run today.** They create and delete test data, so they are locked to a separate
**staging** Supabase project and refuse to touch production — there is no override. No staging
project exists yet (it is an open owner action in `TODO.md`), and the CI E2E job is switched off
for the same reason.

When a staging project exists, set these before any `playwright` command (the `VITE_*` values from
the section above are not enough — Playwright overwrites them with the staging ones):

- `E2E_TARGET_ENV=staging`
- `E2E_SUPABASE_URL` (a non-production `https://*.supabase.co` URL)
- `E2E_SUPABASE_ANON_KEY`
- `E2E_TEST_EMAIL` and `E2E_TEST_PASSWORD` (the staging test account)

Playwright also refuses to start while any file under `tests/e2e/` still contains the production
Supabase address. Full setup and the `[E2E]` test-data rules are in
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#e2e-tests-playwright).

### Running the Tests

Once the staging settings above are in place, run:
```bash
npm run test:e2e
```

This will:
- Start the application automatically
- Open a browser in the background
- Run all the tests
- Show you the results

### Understanding Test Results

When tests finish, you'll see output like this:

✅ **All tests passed:**
```
Running 12 tests using 1 worker

  ✓ auth.spec.ts:6:7 › Authentication › should login with valid credentials (5s)
  ✓ auth.spec.ts:12:7 › Authentication › should logout successfully (3s)
  ...

12 passed (45s)
```

❌ **Some tests failed:**
```
  1) auth.spec.ts:6:7 › Authentication › should login with valid credentials

    Error: Timed out 30000ms waiting for expect(locator).toBeVisible()
```

If tests fail, see the [Troubleshooting](#troubleshooting) section.

### Viewing Test Reports

After tests run, you can view a detailed HTML report:

```bash
npm run test:e2e:report
```

This opens a web page showing:
- Which tests passed/failed
- Screenshots of failures
- Detailed error messages

### Running Tests With Visual Feedback

Want to see the tests running in real-time?

```bash
npm run test:e2e:headed
```

This opens a browser window where you can watch the tests run.

### Interactive Test Mode

For debugging, use the interactive UI:

```bash
npm run test:e2e:ui
```

This opens a special interface where you can:
- Run specific tests
- Step through tests slowly
- See what the browser sees

---

## Staging (not set up yet)

There is **no staging environment** today — no staging Supabase project and no staging branch. The
live app at croprxsolutions.app is the only deployed environment. Creating a staging Supabase
project (plus the GitHub secrets the E2E job needs) is an open owner action in `TODO.md`; until it
exists, the E2E suite and the CI E2E job cannot run.

Do not treat a Vercel preview deployment as a staging area: nothing here proves which database it
talks to, so assume it is the live one.

---

## Pre-Release Checklist

Before deploying any changes to production, run through this checklist:

### ✅ Local Testing

- [ ] Code runs locally without errors (`npm run dev`)
- [ ] Unit tests pass (`npm test`) — CI runs them again on the pull request
- [ ] Production build works (`npm run build` then `npm run preview`)
- [ ] No console errors in the browser (press F12 to check)

### ✅ Manual Testing (locally — there is no staging environment)

- [ ] Test login/logout functionality
- [ ] Create a test customer
- [ ] Create a test order
- [ ] Test search and filter features
- [ ] Test on mobile (resize your browser window)
- [ ] Check that data saves correctly
- [ ] Verify email notifications work (if applicable)

### ✅ Code Review

- [ ] Changes are committed to git
- [ ] Commit messages are clear
- [ ] No sensitive data (passwords, API keys) in the code
- [ ] `.env` file is NOT committed to git (it should be in `.gitignore`)

### ✅ Documentation

- [ ] Update README if needed
- [ ] Document any new features
- [ ] Note any changes to setup process

### ✅ Deployment

- [ ] Push your branch and open a pull request (nobody pushes to `main` directly — it is protected)
- [ ] Required CI checks pass and review is clean
- [ ] Merge the pull request — the merge is what deploys production through Vercel
- [ ] Test production immediately after deployment
- [ ] Monitor error logs for the first hour (Vercel keeps one-click rollback if something is wrong)

The full landing procedure is in `.claude/commands/ship.md`; see also [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Troubleshooting

### Problem: "Module not found" or "Cannot find package"

**Solution:** Install dependencies again
```bash
npm install
```

### Problem: "Port 5173 already in use"

**Solution:** Another instance of the app is running
1. Find and close other terminal windows
2. Or kill the process:
   ```bash
   # Mac/Linux
   lsof -ti:5173 | xargs kill -9

   # Windows
   netstat -ano | findstr :5173
   taskkill /PID [PID_NUMBER] /F
   ```

### Problem: "Environment variables not found" error screen

**Solution:**
1. Make sure `.env` file exists in the project root
2. Check that values are filled in (no empty lines)
3. Restart the dev server (`Ctrl+C` then `npm run dev`)
4. Make sure variable names start with `VITE_`

### Problem: Tests fail with "Timed out waiting for..."

**Possible causes:**
1. **Slow internet:** Tests might need more time
   - Increase timeout in `playwright.config.ts`
2. **Wrong credentials:** Tests can't log in
   - Verify your `.env` has correct values
   - Make sure test user exists in your database
3. **Database connection issues:**
   - Check Supabase dashboard to see if project is paused
   - Verify RLS policies allow the test user to access data

### Problem: E2E tests stop immediately with `E2E_SAFETY: ...`

**Cause:** the staging-only guard refused to start. Either the `E2E_*` settings are missing, they
point at production, or a file under `tests/e2e/` still contains the production Supabase address.
This is expected until a staging project exists — see [Running E2E Tests](#running-e2e-tests).

### Problem: "Permission denied" when running tests

**Solution (Mac/Linux):**
```bash
chmod +x node_modules/.bin/playwright
```

**Solution (Windows):**
Run terminal as Administrator

### Problem: Can't connect to Supabase

**Symptoms:**
- Login doesn't work
- Data doesn't load
- "Failed to fetch" errors

**Solutions:**
1. Check your internet connection
2. Verify Supabase project is not paused (check dashboard)
3. Confirm API keys are correct in `.env`
4. Check Supabase status page: https://status.supabase.com/

### Problem: Build fails with TypeScript errors

**Solution:**
```bash
# Check for type errors
npm run typecheck

# If errors exist, read them carefully
# Most common: missing properties, wrong types
```

### Getting More Help

If you're still stuck:

1. **Check the browser console:** Press F12 and look for red errors
2. **Check terminal output:** Look for error messages
3. **Review recent changes:** What changed since it last worked?
4. **Search the error message:** Copy/paste into Google
5. **Ask for help:** Share the error message and what you were doing

---

## Quick Command Reference

### Development
```bash
npm install          # Install dependencies (run once)
npm run dev          # Start development server
npm run build        # Build for production
npm run preview      # Preview production build locally
npm run typecheck    # Check TypeScript errors
npm run lint         # Run ESLint
```

### Unit Tests (Vitest)
```bash
npm test                  # Run the full unit-test suite
npm run test:watch        # Run unit tests in watch mode
npm run test:coverage     # Full suite with the coverage report CI uses
npm run test:billing      # One focused area; also test:inventory, test:lifecycle,
                          # test:pricing, test:security, test:idempotency,
                          # test:regression, test:drift (all via test:area)
npm run test:contracts    # RPC contract and idempotency inventory tests
npm run check:docs        # Documentation consistency check CI runs
```

### E2E Tests (Playwright)
```bash
npm run test:e2e          # Run all E2E tests
npm run test:e2e:ui       # Interactive test UI
npm run test:e2e:headed   # Watch tests run in browser
npm run test:e2e:report   # View test report
npm run test:e2e:smoke    # Only the @smoke-tagged E2E tests
```
(All E2E commands need the staging settings described above.)

### Live-database checks (read-only)
```bash
npm run db-sweeps         # Database-invariant sweeps (see scripts/db-invariant-sweeps/README.md)
npm run smoke             # Rolled-back smoke chains (see scripts/smoke/README.md)
```

> **Hooks:** pre-commit runs fast staged-file checks; pre-push runs typecheck and build; CI runs lint, tests, and the build on every pull request.

### Git Commands
```bash
git status                    # See what changed
git add .                     # Stage all changes
git commit -m "message"       # Commit changes
git push                      # Push your branch to GitHub (never to main)
git pull                      # Pull latest changes
```

---

## Testing Best Practices

1. **Test locally first:** Always run tests on your computer before pushing code
2. **Land through a pull request:** never push to `main`; the merge is what deploys production
3. **Run tests regularly:** Run after every significant change
4. **Check both automated and manual testing:** Automated tests don't catch everything
5. **Test on multiple browsers:** Chrome, Firefox, Safari when possible
6. **Test on mobile:** Resize browser or use real devices
7. **Monitor after deployment:** Watch for errors in the first hour after deploying

---

## Need Help?

This guide covers the most common scenarios. If you run into issues:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review error messages carefully
3. Search for the error message online
4. Check the Supabase dashboard for database issues
5. Reach out to your development team with specific error details

Remember: It's okay to ask for help! Provide:
- What you were trying to do
- The exact error message
- What you've tried so far
- Screenshots if helpful
