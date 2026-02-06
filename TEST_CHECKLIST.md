# Quick Testing Checklist

Use this checklist after making any changes to ensure everything still works.

## ✅ One-Command Verification

Run this single command to verify everything works:

```bash
npm run build && npm run preview
```

If this succeeds, your app builds correctly and can be deployed.

## ✅ Before Every Deployment

Copy this checklist and check off each item:

### Local Tests (5 minutes)
- [ ] `npm run build` - succeeds without errors
- [ ] `npm run preview` - app loads at http://localhost:4173
- [ ] Can log in successfully
- [ ] Can create a customer
- [ ] Can search for records
- [ ] No red errors in browser console (press F12)

### Automated Tests (2 minutes)
- [ ] `npm run test:e2e` - all tests pass

### Code Quality (1 minute)
- [ ] Changes are committed to git
- [ ] Commit message is clear
- [ ] No `.env` file committed (check `git status`)

### Staging (24 hours)
- [ ] Deploy to staging
- [ ] Test on staging environment
- [ ] Wait 24 hours for any issues
- [ ] No errors reported

### Production Deployment
- [ ] All above items checked
- [ ] Push to main branch
- [ ] Monitor production for 1 hour after deployment

---

## 🚨 If Tests Fail

### Build Fails
```bash
# Try reinstalling dependencies
rm -rf node_modules package-lock.json
npm install
npm run build
```

### Tests Fail
- Check that test user exists in database (test@example.com)
- Verify `.env` has correct credentials
- See TESTING.md troubleshooting section

### Preview Doesn't Load
- Kill any running dev servers
- Try a different port: `npm run preview -- --port 4174`
- Check browser console for errors

---

## 📱 Manual Testing Checklist

After automated tests pass, manually verify these critical flows:

### Authentication
- [ ] Login with valid credentials
- [ ] Invalid credentials show error
- [ ] Logout works
- [ ] Cannot access protected pages when logged out

### Customer Management
- [ ] Create new customer
- [ ] Edit customer details
- [ ] Search for customers
- [ ] View customer details

### Order Flow
- [ ] Create new order
- [ ] Add line items
- [ ] Calculate totals correctly
- [ ] Save order

### Permissions
- [ ] Admin can access settings
- [ ] Regular users cannot access restricted pages
- [ ] Users can only see their own data

---

## 🎯 Quick Commands Reference

```bash
# Development
npm run dev              # Start dev server
npm run build            # Build for production
npm run preview          # Test production build

# Testing
npm run test:e2e         # Run all tests
npm run test:e2e:ui      # Interactive test mode

# Verification
npm run typecheck        # Check for type errors
npm run lint             # Check code style
```

---

## ⏱️ Time Estimates

- **Quick verify:** 1 minute (build + preview)
- **Full local testing:** 5 minutes
- **Automated tests:** 2 minutes
- **Manual testing:** 10 minutes
- **Total before deploy:** ~20 minutes

---

## 💡 Tips

1. **Test locally first, always**
   - Never push without building locally
   - Catch errors before they reach staging

2. **Use staging like production**
   - Always deploy to staging first
   - Test thoroughly on staging
   - Wait before pushing to production

3. **Monitor after deployment**
   - Watch the first hour closely
   - Check browser console
   - Review error logs

4. **Keep it simple**
   - If a test fails, fix it before deploying
   - Don't skip tests "just this once"
   - When in doubt, test again

---

## 🆘 Emergency Rollback

If production breaks after deployment:

### Netlify
1. Go to Deploys
2. Find last working deploy
3. Click "Publish deploy"

### Vercel
1. Go to Deployments
2. Find last working deployment
3. Click "Promote to Production"

---

Print this checklist and keep it handy. Run through it before every deployment to catch issues early.
