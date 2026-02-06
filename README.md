# CRX Manager V1.0

A comprehensive business management system for handling customers, products, orders, quotes, and more.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ installed
- Supabase account with project set up
- Git installed

### Setup in 5 Minutes

1. **Clone and install:**
   ```bash
   git clone [YOUR_REPO_URL]
   cd CRX_Manager_V1.0
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   # Edit .env and add your Supabase credentials
   ```

3. **Start development server:**
   ```bash
   npm run dev
   ```

4. **Open browser:**
   - Navigate to http://localhost:5173/

## 📚 Documentation

- **[TESTING.md](./TESTING.md)** - Complete testing guide (no coding experience needed)
- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - How to deploy to production
- **[VERIFICATION.md](./VERIFICATION.md)** - Setup verification and known issues

## 🧪 Testing

Run the complete test suite:
```bash
npm run test:e2e
```

Interactive test interface:
```bash
npm run test:e2e:ui
```

See [TESTING.md](./TESTING.md) for detailed instructions.

## 🔧 Available Commands

### Development
```bash
npm run dev          # Start dev server
npm run build        # Build for production
npm run preview      # Preview production build
npm run typecheck    # Check TypeScript errors
```

### Testing
```bash
npm run test:e2e          # Run E2E tests
npm run test:e2e:ui       # Interactive test UI
npm run test:e2e:report   # View test report
```

## 🏗️ Tech Stack

- **Frontend:** React 18, TypeScript, Vite
- **Styling:** Tailwind CSS
- **Database:** Supabase (PostgreSQL)
- **Authentication:** Supabase Auth
- **Testing:** Playwright
- **Icons:** Lucide React

## 📦 Features

- Customer Management
- Product Catalog
- Order Processing
- Quote Builder
- Inventory Tracking
- Purchase Orders
- Delivery Management
- Blend Tickets System
- Team Collaboration
- Real-time Notifications
- Brand vs Generic Comparison
- Reports & Analytics

## 🔐 Environment Variables

Required environment variables (see `.env.example`):

```env
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-anon-key
```

**Note:** All variables must start with `VITE_` to be accessible in the app.

## 🚢 Deployment

This project is configured for easy deployment to:
- Netlify (recommended)
- Vercel

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete instructions.

### Quick Deploy to Netlify

1. Push code to GitHub
2. Connect repository to Netlify
3. Configure build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. Add environment variables
5. Deploy!

## 🐛 Troubleshooting

### App shows "Configuration Error"
- Ensure `.env` file exists with valid Supabase credentials
- Restart dev server after adding environment variables

### Tests fail
- Verify test user exists in database (mason@croprxsolutions.com)
- Check `.env` has correct Supabase credentials
- See [TESTING.md](./TESTING.md) troubleshooting section

### Build fails
- Run `npm install` to ensure all dependencies are installed
- Check for TypeScript errors: `npm run typecheck`

## 📝 Contributing

1. Create a feature branch
2. Make your changes
3. Run tests: `npm run test:e2e`
4. Build to verify: `npm run build`
5. Submit pull request

## 📄 License

Private - All rights reserved

## 🆘 Support

For issues or questions:
1. Check [TESTING.md](./TESTING.md) and [DEPLOYMENT.md](./DEPLOYMENT.md)
2. Review [VERIFICATION.md](./VERIFICATION.md) for known issues
3. Contact your development team

---

**Version:** 1.0
**Last Updated:** 2026-02-06
