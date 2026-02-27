# Setup Guide - New Computer

## Current Environment
- OS: Windows 10/11
- Node.js: v24.13.0, npm: 11.6.2
- Git: 2.53.0
- GitHub CLI: at "C:\Program Files\GitHub CLI\gh.exe"

## Prerequisites
1. **Node.js** (v18+ required, currently using v24.13.0)
   - Download from https://nodejs.org
   - npm comes bundled

2. **Git** — https://git-scm.com
   - During install: "Git from the command line and also from 3rd-party software"

3. **GitHub CLI (gh)**
   - `winget install --id GitHub.cli`
   - `gh auth login` -> GitHub.com -> HTTPS -> Login with web browser
   - Verify: `gh auth status`

4. **Claude Code**
   - `npm install -g @anthropic-ai/claude-code`
   - Run: `claude` in terminal

## Clone & Install
```bash
gh repo clone masonwells1/CRX_Manager_V1.0
cd CRX_Manager_V1.0
npm install
```

## Environment Setup
Create `.env` file in project root (get values from Supabase Dashboard -> Settings -> API):
```
VITE_SUPABASE_URL=<your-supabase-url>
VITE_SUPABASE_ANON_KEY=<your-anon-key>
VITE_MAPBOX_TOKEN=pk.<your-mapbox-token>
```

## Verify
```bash
npm run dev        # Should start on localhost:5173
npm run build      # Should build without errors
npm run typecheck  # Should pass with 0 errors
npm run lint       # Should pass with 0 errors
```

## Notes
- gh CLI may not be on PATH in Claude Code bash — use: `"/c/Program Files/GitHub CLI/gh.exe"`
- Always run `npm install` after cloning (installs dependencies)
- `.env` is gitignored — create it on each computer
- Test user: mason@croprxsolutions.com
- GitHub: masonwells1 (HTTPS auth)
- Repo: https://github.com/masonwells1/CRX_Manager_V1.0
