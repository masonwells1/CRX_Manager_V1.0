# Deployment Guide

This guide explains how to deploy your application to production.

## Prerequisites

Before deploying, ensure:
- ✅ All unit tests pass (`npm test`)
- ✅ All E2E tests pass (`npm run test:e2e`)
- ✅ Production build works (`npm run build`)
- ✅ Changes tested on staging environment
- ✅ Supabase production database is ready
- ✅ All migrations are applied

## Deployment

### Vercel (Current Deployment)

#### Initial Setup

1. **Create Vercel Account**
   - Go to https://vercel.com
   - Sign up with GitHub

2. **Import Project**
   - Click "Add New Project"
   - Select your repository
   - Click "Import"

3. **Configure Project**
   ```
   Framework Preset: Vite
   Build Command: npm run build
   Output Directory: dist
   Install Command: npm install
   ```

4. **Environment Variables**
   - Click "Environment Variables"
   - Add:
     - `VITE_SUPABASE_URL`
     - `VITE_SUPABASE_ANON_KEY`
   - Select "Production, Preview, and Development"

5. **Deploy**
   - Click "Deploy"
   - Wait for deployment to complete

#### Continuous Deployment

Automatic deployment on every push to main branch.

#### Custom Domain

1. Go to "Settings" → "Domains"
2. Add your domain
3. Configure DNS as instructed
4. SSL is automatic

---

## Environment Setup

### Production Environment Variables

Your production `.env` should contain:

```env
VITE_SUPABASE_URL=https://your-production-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-production-anon-key
VITE_MAPBOX_TOKEN=pk.your-mapbox-token
VITE_SENTRY_DSN=https://your-sentry-dsn (optional)
```

**Security Notes:**
- ✅ The anon key is safe to expose in the browser
- ✅ Database security is handled by Row Level Security (RLS)
- ❌ Never commit `.env` to git
- ❌ Never expose service_role key in the browser

### Staging vs Production

| Environment | Purpose | Database | URL |
|------------|---------|----------|-----|
| **Local** | Development | Local Supabase | localhost:5173 |
| **Staging** | Pre-release testing | Staging Supabase | Vercel preview deployments |
| **Production** | Live application | Production Supabase | croprxsolutions.app |

---

## Pre-Deployment Checklist

### Code Quality
- [ ] All TypeScript errors fixed (`npm run typecheck`)
- [ ] Linter passes (`npm run lint`)
- [ ] No console.log statements in production code
- [ ] All TODO comments addressed

### Testing
- [ ] All unit tests pass (`npm test`)
- [ ] All E2E tests pass (`npm run test:e2e`)
- [ ] Manual testing completed on staging
- [ ] Mobile responsiveness verified
- [ ] Cross-browser testing done (Chrome, Firefox, Safari)

### Database
- [ ] All migrations applied to production
- [ ] RLS policies tested and verified
- [ ] Database backups enabled
- [ ] Performance indexes created

### Security
- [ ] Environment variables configured correctly
- [ ] No secrets in codebase
- [ ] CORS settings correct
- [ ] Authentication working
- [ ] Authorization/permissions tested
- [ ] Supabase Edge Function secrets set (see below)

### Supabase Edge Function Secrets

Seven JWT-protected Edge Functions were active in production when verified on 2026-08-09:
`create-user`, `setup-blend-tickets-storage`, `process-blend-ticket`, `process-document`,
`send-email`, `reset-user-password`, and `epa-lookup`. The function-specific secrets below must be
present wherever the corresponding function uses them.

| Secret | Purpose | How to set |
|--------|---------|------------|
| `ALLOWED_ORIGIN` | CORS origin for Edge Function responses. Must exactly match `https://croprxsolutions.app` (no trailing slash). | `npx supabase secrets set ALLOWED_ORIGIN=https://croprxsolutions.app --project-ref rhyzpcqhnizqbxphqdkr` |
| `SUPABASE_SERVICE_ROLE_KEY` | Needed by `create-user` to create auth users. Already set by default on hosted Supabase. | Auto-provisioned; verify in Dashboard → Settings → Edge Functions → Environment Variables. |
| `GOOGLE_VISION_API_KEY` | Used by `process-blend-ticket` for OCR. | `npx supabase secrets set GOOGLE_VISION_API_KEY=<key> --project-ref <ref>` |

**Verification steps:**
1. Run `npx supabase secrets list --project-ref <ref>` to confirm all secrets are set.
2. After deploying, test each Edge Function from the frontend to confirm CORS headers are correct.
3. If you see `403` or `CORS` errors in the browser console, double-check `ALLOWED_ORIGIN` matches the exact origin (including protocol, no trailing slash).

### Performance
- [ ] Build size reasonable (`npm run build` check output)
- [ ] Images optimized
- [ ] No large dependencies
- [ ] Lazy loading implemented where needed

---

## Deployment Process

### Step-by-Step Production Deployment

1. **Test Everything Locally**
   ```bash
   npm run build
   npm run preview
   npm run test:e2e
   ```

2. **Deploy to Staging First**
   - Push code to staging branch
   - Verify staging deployment succeeds
   - Test staging thoroughly
   - Wait 24 hours to catch any issues

3. **Merge to Production**
   ```bash
   git checkout main
   git merge staging
   git push origin main
   ```

4. **Monitor Deployment**
   - Watch build logs on Vercel
   - Check for any build errors
   - Verify deployment completes successfully

5. **Post-Deployment Testing**
   - Open production URL
   - Test critical user flows:
     - Login/logout
     - Create customer
     - Create order
     - Search functionality
   - Check browser console for errors
   - Test on mobile device

6. **Monitor for Issues**
   - Watch Supabase logs
   - Monitor error rates
   - Check user feedback
   - Be ready to rollback if needed

---

## Rollback Procedure

If something goes wrong after deployment:

### Vercel Rollback

1. Go to "Deployments" in Vercel dashboard
2. Find the last working deployment
3. Click "..." → "Promote to Production"
4. Previous version is now live

### Git Rollback

If you need to revert code:
```bash
git log                           # Find commit hash to revert to
git revert <commit-hash>          # Creates a new commit that undoes changes
git push origin main              # Push the revert
```

---

## Monitoring Production

### What to Monitor

1. **Error Rates**
   - Check browser console errors
   - Monitor Supabase error logs
   - Watch for failed requests

2. **Performance**
   - Page load times
   - API response times
   - Database query performance

3. **User Issues**
   - Failed login attempts
   - Incomplete transactions
   - User reports

### Monitoring Tools

#### Supabase Dashboard
- Database activity
- API usage
- Error logs
- Real-time connections

#### Browser DevTools
- Console errors (F12)
- Network requests
- Performance metrics

#### Vercel Analytics
- Visitor count
- Page load times
- Bandwidth usage

---

## Continuous Integration (CI)

### GitHub Actions (already configured)

CI is **not** optional and does not need to be created — it already runs on every
pull request into `main` and on every push to `main`. Four workflows live in
`.github/workflows/`:

| Workflow | What it does |
|---|---|
| `ci.yml` | The main gate. Lint, type check, unit tests, build, SQL migration validation, an E2E smoke run, and the Phase 3C private-artifact containment check. |
| `production-migration.yml` | Guards the live-migration path. |
| `production-approval-canary.yml` | Watches that the production approval gate still refuses what it is supposed to refuse. |
| `phase3-private-artifact-containment.yml` | Standalone containment check for candidate artifacts. |

The jobs inside `ci.yml` are `phase3-private-artifact-containment`, `ci-scope`,
`sql-validation`, `lint-typecheck-test`, `phase3c-containment-windows`, and
`e2e-smoke`. `ci-scope` classifies each change fail-closed, so a docs-only pull
request can skip the expensive proof steps while anything touching code, SQL, or
the agent surface gets the full run.

To reproduce the important parts of CI locally before pushing:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Edit the workflow files directly if CI needs to change; do not add a parallel
`test.yml`.

---

## Troubleshooting Deployment

### Build Fails

**Error: "Module not found"**
- Solution: Check `package.json` has all dependencies
- Run `npm install` locally to verify

**Error: "Out of memory"**
- Solution: Increase Node memory in build command:
  ```
  NODE_OPTIONS="--max-old-space-size=4096" npm run build
  ```

### Environment Variables Not Working

**Symptoms:**
- App shows "Configuration Error" screen
- Features don't work in production

**Solutions:**
1. Verify variable names start with `VITE_`
2. Check they're set in hosting dashboard
3. Redeploy after adding variables
4. Check for typos in variable names

### Database Connection Issues

**Symptoms:**
- "Failed to fetch" errors
- Login doesn't work
- Data doesn't load

**Solutions:**
1. Verify Supabase project is not paused
2. Check RLS policies allow access
3. Confirm environment variables are correct
4. Check Supabase API limits/quotas

### SSL Certificate Issues

**Symptoms:**
- "Not secure" warning
- HTTPS doesn't work

**Solutions:**
- Wait 24 hours for SSL to provision
- Check DNS settings
- Contact hosting support if still failing

---

## Best Practices

### Version Control
- Use semantic versioning (e.g., v1.0.0, v1.1.0)
- Tag releases in git
- Keep detailed changelog

### Testing Strategy
- Test locally first, always
- Use staging for pre-production testing
- Never deploy directly to production
- Have a rollback plan ready

### Database Management
- Always backup before major changes
- Test migrations on staging first
- Use migration files (never manual changes)
- Keep staging and production schemas in sync

### Security
- Rotate secrets regularly
- Monitor for unauthorized access
- Keep dependencies updated
- Review RLS policies regularly

### Communication
- Announce maintenance windows
- Document all changes
- Keep stakeholders informed
- Maintain deployment log

---

## Production Checklist

Print this out and check off before each production deployment:

### Pre-Deployment
- [ ] All tests pass locally
- [ ] Code reviewed
- [ ] Staging tested for 24+ hours
- [ ] Database migrations ready
- [ ] Environment variables configured
- [ ] Rollback plan prepared

### Deployment
- [ ] Deploy during low-traffic period
- [ ] Monitor build process
- [ ] Verify successful deployment
- [ ] Check production URL loads

### Post-Deployment
- [ ] Test critical user flows
- [ ] Check for console errors
- [ ] Monitor error rates (15 min)
- [ ] Verify database connections
- [ ] Test on mobile
- [ ] Announce deployment complete

### First 24 Hours
- [ ] Monitor error logs
- [ ] Watch user feedback
- [ ] Check performance metrics
- [ ] Be ready to rollback

---

## Support

If you encounter issues during deployment:

1. Check the build logs carefully
2. Review environment variables
3. Verify database connectivity
4. Test in staging environment
5. Check Vercel status page
6. Contact hosting support if needed

## Additional Resources

- [Vercel Documentation](https://vercel.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Vite Deployment Guide](https://vitejs.dev/guide/static-deploy.html)
