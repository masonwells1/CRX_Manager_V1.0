# Testing Guide

This guide will walk you through testing the application. No coding experience needed!

## Quick Facts

| Metric | Count |
|--------|-------|
| **Unit tests** | 1,433 (Vitest, 92 test files in `src/`) |
| **E2E specs** | 98 Playwright spec files (589 tests in `tests/e2e/`) |
| **Pre-commit hook** | Runs `npm run build` + `npm test` before every commit — blocks if anything fails |

## Table of Contents
1. [Setting Up Your Computer](#setting-up-your-computer)
2. [Running the Application Locally](#running-the-application-locally)
3. [Running Unit Tests](#running-unit-tests)
4. [Running E2E Tests](#running-e2e-tests)
5. [Deploying to Staging](#deploying-to-staging)
6. [Pre-Release Checklist](#pre-release-checklist)
7. [Troubleshooting](#troubleshooting)

---

## Setting Up Your Computer

Before you start, you need to install a few programs on your computer:

### 1. Install Node.js

Node.js is required to run the application.

1. Go to https://nodejs.org/
2. Download the "LTS" (Long Term Support) version
3. Run the installer and follow the instructions
4. To verify it's installed, open Terminal (Mac) or Command Prompt (Windows) and type:
   ```bash
   node --version
   ```
   You should see a version number like `v18.17.0`

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

This runs all 1,433 unit tests across 92 test files. Takes about 10-20 seconds.

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
- **Bulk import:** BulkCustomerImport, BulkOrderImport, BulkProductImport, BulkPricingImport, BulkPOImport, BulkQuoteImport, BulkTicketUpload, ManualTicketCreate

### Pre-Commit Hook

Every time you commit code, the pre-commit hook automatically runs:
1. `npm run build` — ensures the app compiles
2. `npm test` — ensures all 1,433 unit tests pass

If either fails, the commit is **blocked**. You must fix the issue before committing.

---

## Running E2E Tests

E2E (end-to-end) tests open a real browser and test the full application — login, creating records, navigating pages, etc.

### What Do These Tests Check?

- **Login/Logout:** Can users log in and out?
- **Customer Management:** Can you create, view, and search for customers?
- **Permissions:** Can users access the pages they're supposed to?
- **All 50 pages:** Every page is tested for loading and basic functionality

### Running the Tests

1. Make sure the `.env` file is set up (see previous section)
2. In your terminal, run:
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

## Deploying to Staging

Staging is a separate environment where you can test changes before deploying to production.

### Why Use Staging?

- Test with real-world data without affecting your customers
- Verify everything works in a production-like environment
- Catch issues before they reach your users

### Setting Up Staging

#### Step 1: Create a Staging Database

**Important:** Never use your production database for testing!

1. Go to https://supabase.com/dashboard
2. Click "New Project"
3. Name it something like "YourApp Staging"
4. Choose the same region as your production database
5. Set a strong password
6. Wait for the project to be created (takes 1-2 minutes)

#### Step 2: Get Staging Credentials

1. In your staging project, go to Settings → API
2. Copy the Project URL and anon key
3. Keep these handy for the next step

#### Step 3: Deploy to Vercel

Vercel is the hosting service used for this project.

1. Go to https://vercel.com and sign up with GitHub
2. Click "Add New Project"
3. Import your GitHub repository
4. Configure:
   - **Framework Preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
5. Click "Environment Variables" and add your staging credentials:
   - `VITE_SUPABASE_URL` → [your staging URL]
   - `VITE_SUPABASE_ANON_KEY` → [your staging anon key]
6. Click "Deploy"

After 2-3 minutes, your staging site will be live with a URL like `https://your-project.vercel.app`

#### Step 4: Test Your Staging Site

1. Open the staging URL in your browser
2. Try logging in
3. Create a test customer, product, or order
4. Verify everything works as expected

---

## Pre-Release Checklist

Before deploying any changes to production, run through this checklist:

### ✅ Local Testing

- [ ] Code runs locally without errors (`npm run dev`)
- [ ] All automated tests pass (`npm run test:e2e`)
- [ ] Production build works (`npm run build` then `npm run preview`)
- [ ] No console errors in the browser (press F12 to check)

### ✅ Staging Testing

- [ ] Deploy changes to staging environment
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

- [ ] Push changes to GitHub
- [ ] Verify staging deployment succeeded
- [ ] Monitor staging for 24 hours for any issues
- [ ] Deploy to production
- [ ] Test production immediately after deployment
- [ ] Monitor error logs for the first hour

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

### Problem: Tests pass locally but fail on staging

**Possible causes:**
1. Environment variables not set correctly on Vercel
2. Staging database has different data/structure
3. Migration didn't run on staging database

**Solution:**
- Check environment variables in hosting dashboard
- Verify staging database schema matches production
- Check browser console for errors

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
npm test                  # Run all 1,433 unit tests
npm run test:watch        # Run unit tests in watch mode
```

### E2E Tests (Playwright)
```bash
npm run test:e2e          # Run all E2E tests
npm run test:e2e:ui       # Interactive test UI
npm run test:e2e:headed   # Watch tests run in browser
npm run test:e2e:report   # View test report
```

> **Pre-commit hook:** `npm run build` + `npm test` run automatically before every commit. Commits are blocked if anything fails.

### Git Commands
```bash
git status                    # See what changed
git add .                     # Stage all changes
git commit -m "message"       # Commit changes
git push                      # Push to GitHub
git pull                      # Pull latest changes
```

---

## Testing Best Practices

1. **Test locally first:** Always run tests on your computer before pushing code
2. **Test staging before production:** Never deploy directly to production
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
