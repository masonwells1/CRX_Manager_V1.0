# Prompt Templates for Claude Desktop App

Copy-paste these prompts into the Claude desktop app for common tasks. Each prompt is inside a code block so you can easily select and copy it.

---

## 1. Start of Session Prompt

**Use this:** At the beginning of every new Claude desktop session.

```
I'm working on CRX Manager, an agricultural product distribution management app. Before we do anything:

1. Read the file CLAUDE.md in the project root
2. Read the file docs/workflows/SAFE_DEVELOPMENT_RULES.md

After reading both, tell me in one sentence that you've loaded the context and are ready. Don't summarize the files — just confirm you've read them.

The project is at: C:\Users\pc\CRX_Manager_V1.0
```

---

## 2. New Feature Prompt

**Use this:** When you want Claude to build something new.

```
I want to add a new feature to CRX Manager. Here's what I need:

[DESCRIBE THE FEATURE HERE]

Before writing any code:
1. Read CLAUDE.md and docs/workflows/SAFE_DEVELOPMENT_RULES.md
2. Search the codebase to see if something similar already exists
3. Read the relevant workflow docs in docs/workflows/ for this area
4. Read the source files that would be affected

Then show me a plan that includes:
- What files you'll create or modify (exact paths)
- What database changes are needed (if any)
- What the user will see when it's done
- Any risks or things that could break

Wait for my approval before making any changes. Do NOT start coding until I say "go ahead" or "approved".
```

---

## 3. Fix Bug Prompt

**Use this:** When something isn't working right.

```
There's a bug in CRX Manager. Here's what's happening:

[DESCRIBE THE BUG — what you expected vs what actually happened]

Please fix this systematically:
1. First, read the relevant source files to understand the current code
2. Identify the root cause (don't just guess — trace the logic)
3. Show me what you think the problem is and your proposed fix
4. Make the minimum change needed to fix it — don't refactor surrounding code
5. After fixing, run npm run typecheck and npm run build to verify nothing broke

The project is at: C:\Users\pc\CRX_Manager_V1.0
```

---

## 4. Add Database Column Prompt

**Use this:** When you need to add a new field to a database table.

```
I need to add a new column to a database table in CRX Manager.

Table: [TABLE NAME]
Column name: [COLUMN NAME]
Type: [e.g., TEXT, BIGINT, BOOLEAN, TIMESTAMPTZ, UUID]
Default value: [e.g., NULL, 'draft', NOW(), false]
Nullable: [yes/no]

Please follow the complete checklist in docs/workflows/DATABASE_CHANGE_CHECKLIST.md:
1. Create a new migration file in supabase/migrations/
2. Write idempotent SQL (using IF NOT EXISTS)
3. Update the TypeScript interface in src/types/index.ts
4. Show me the migration SQL before applying it
5. Tell me which components need to be updated to use this new column
6. Run npm run typecheck after making changes

Wait for my approval before applying the migration.
```

---

## 5. Add New Page Prompt

**Use this:** When you need a new page in the app.

```
I need a new page in CRX Manager.

Page name: [NAME]
Route: [e.g., /my-new-page]
What it should do: [DESCRIBE THE PAGE]

Please follow the 4-step checklist in docs/workflows/UI_PATTERNS.md:
1. Create the page component in src/pages/
2. Add the lazy import in src/App.tsx
3. Add the Route in the protected route block
4. Add the sidebar navigation link in AppLayout.tsx

Before building, first:
- Check that this page doesn't already exist (there are 49 pages)
- Read docs/workflows/UI_PATTERNS.md for the patterns to follow
- Show me a plan of what you'll build

Use the established patterns: useState + useEffect for data fetching, checkMutationResult for writes, Tailwind for styling, Lucide React for icons.
```

---

## 6. Pre-Deploy Check Prompt

**Use this:** Before pushing code to production.

```
Please run a pre-deploy check on CRX Manager:

1. Run npm run typecheck — are there any TypeScript errors?
2. Run npm run build — does the app build successfully?
3. Check for any console.log statements that shouldn't be in production code
4. Check for any @ts-ignore or 'any' types that were added
5. Check that no .env files are staged for commit
6. Look at the recent changes and verify:
   - All new database tables have RLS policies
   - All write operations use checkMutationResult()
   - All new user actions have logActivity() calls
   - Types in src/types/index.ts match any database changes

Report what you find. If everything passes, tell me it's safe to deploy.
```

---

## 7. Code Review Prompt

**Use this:** After making changes, to catch mistakes.

```
Please review the recent changes in CRX Manager for safety issues.

Look at the files that were recently modified and check for:

Security:
- [ ] New tables have RLS enabled and policies created
- [ ] No service_role key exposed in frontend code
- [ ] RLS policies use (select auth.uid()) not bare auth.uid()
- [ ] No sensitive data logged to console

Data integrity:
- [ ] All .update() and .delete() calls use checkMutationResult()
- [ ] All RPC calls use assertRpcResult() where appropriate
- [ ] Money stored as bigint cents (not float)
- [ ] Status transitions follow the defined lifecycles

Code quality:
- [ ] TypeScript types updated in src/types/index.ts for any schema changes
- [ ] No @ts-ignore or 'any' types added
- [ ] Activity logging added for important user actions
- [ ] Idempotency keys used for critical writes

Tell me what you found — both issues and things that look good.
```

---

## Tips for Using These Templates

1. **Always start with Template 1** (Session Start) — this ensures Claude has the project context loaded
2. **Copy the template, then add your description** — replace the `[BRACKETS]` with your specific details
3. **Wait for the plan** — Templates 2, 4, and 5 tell Claude to show a plan and wait for approval
4. **One task at a time** — don't paste multiple templates in one message. Finish one task before starting the next.
5. **If Claude seems confused** — paste Template 1 again to reload the context
