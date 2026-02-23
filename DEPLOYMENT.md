# Deployment Guide

This guide explains how to deploy your application to production.

## Prerequisites

Before deploying, ensure:
- ✅ All tests pass locally (`npm run test:e2e`)
- ✅ Production build works (`npm run build`)
- ✅ Changes tested on staging environment
- ✅ Supabase production database is ready
- ✅ All migrations are applied

## Deployment Options

### Option 1: Netlify (Recommended for Beginners)

#### Initial Setup

1. **Create Netlify Account**
   - Go to https://netlify.com
   - Sign up with your GitHub account

2. **Connect Repository**
   - Click "Add new site" → "Import an existing project"
   - Choose "GitHub"
   - Select your repository
   - Grant permissions if prompted

3. **Configure Build Settings**
   ```
   Build command: npm run build
   Publish directory: dist
   ```

4. **Add Environment Variables**
   - Click "Show advanced" → "Add environment variable"
   - Add these variables from your production Supabase project:
     - `VITE_SUPABASE_URL`
     - `VITE_SUPABASE_ANON_KEY`

5. **Deploy**
   - Click "Deploy site"
   - Wait 2-3 minutes for initial deployment
   - You'll get a URL like `https://random-name-123.netlify.app`

#### Continuous Deployment

After initial setup, Netlify automatically deploys when you push to GitHub:
1. Make changes to your code
2. Commit and push to GitHub
3. Netlify automatically builds and deploys

#### Custom Domain

1. In Netlify, go to "Domain settings"
2. Click "Add custom domain"
3. Enter your domain name
4. Follow DNS configuration instructions
5. Wait for SSL certificate to be issued (automatic)

---

### Option 2: Vercel

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
| **Staging** | Pre-release testing | Staging Supabase | staging.yourapp.com |
| **Production** | Live application | Production Supabase | yourapp.com |

---

## Pre-Deployment Checklist

### Code Quality
- [ ] All TypeScript errors fixed (`npm run typecheck`)
- [ ] Linter passes (`npm run lint`)
- [ ] No console.log statements in production code
- [ ] All TODO comments addressed

### Testing
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

The following secrets **must** be set on your Supabase project before
Edge Functions (`create-user`, `process-blend-ticket`) will work in production.

| Secret | Purpose | How to set |
|--------|---------|------------|
| `ALLOWED_ORIGIN` | CORS origin for Edge Function responses. Must match your production URL (e.g., `https://app.croprxsolutions.com`). | `npx supabase secrets set ALLOWED_ORIGIN=https://your-domain.com --project-ref <ref>` |
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
   - Watch build logs on Netlify/Vercel
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

### Netlify Rollback

1. Go to "Deploys" in Netlify dashboard
2. Find the last working deployment
3. Click the three dots (...)
4. Click "Publish deploy"
5. Previous version is now live

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

#### Netlify/Vercel Analytics
- Visitor count
- Page load times
- Bandwidth usage

---

## Continuous Integration (CI)

### GitHub Actions (Optional)

Create `.github/workflows/test.yml`:

```yaml
name: Test

on:
  push:
    branches: [ main, staging ]
  pull_request:
    branches: [ main, staging ]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
    - uses: actions/checkout@v3

    - name: Setup Node
      uses: actions/setup-node@v3
      with:
        node-version: '18'

    - name: Install dependencies
      run: npm install

    - name: Run TypeScript check
      run: npm run typecheck

    - name: Run linter
      run: npm run lint

    - name: Build
      run: npm run build

    - name: Run E2E tests
      run: npm run test:e2e
      env:
        VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
        VITE_SUPABASE_ANON_KEY: ${{ secrets.VITE_SUPABASE_ANON_KEY }}
```

This automatically runs tests on every commit.

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
5. Check Netlify/Vercel status pages
6. Contact hosting support if needed

## Additional Resources

- [Netlify Documentation](https://docs.netlify.com/)
- [Vercel Documentation](https://vercel.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Vite Deployment Guide](https://vitejs.dev/guide/static-deploy.html)
