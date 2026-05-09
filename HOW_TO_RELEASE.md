# How to Release an Update

## One-time setup (do this once)

### 1. Set your GitHub repo name in package.json
Open `package.json` and replace these two lines under `"build" > "publish"`:
```json
"owner": "YOUR_GITHUB_USERNAME",
"repo":  "YOUR_REPO_NAME"
```
Example:
```json
"owner": "abdel",
"repo":  "as-team-dashboard"
```

### 2. Create a GitHub Personal Access Token
1. Go to GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Create a token with **Contents: Read & Write** permission on your repo
3. Copy it — you'll use it as `GH_TOKEN` below

### 3. Install electron-updater
```bash
npm install
```

---

## Every time you release an update

### Step 1 — Bump the version number
Open `package.json` and change `"version"`:
```json
"version": "1.0.1"   ← change this (was 1.0.0)
```
Use format: `MAJOR.MINOR.PATCH`
- Bug fix only → bump PATCH (1.0.0 → 1.0.1)
- New feature → bump MINOR (1.0.0 → 1.1.0)

### Step 2 — Build and publish to GitHub

**On Windows** (builds Windows installer):
```bash
set GH_TOKEN=your_github_token_here
npm run release:win
```

**On Mac** (builds Mac DMG):
```bash
export GH_TOKEN=your_github_token_here
npm run release:mac
```

This will:
- Build the app
- Create a GitHub Release automatically
- Upload the installer + update files to that release
- Clients will see the update within minutes of opening the app

### Step 3 — Done
That's it. The app checks for updates 3 seconds after launch.
When a new version is available:
- A toast notification appears (bottom-right corner)
- Client clicks **"Download Update"** → downloads in background
- Progress bar shows download %
- When done, button changes to **"Restart & Install"**
- One click → app restarts with new version installed

---

## How the update check works

| Event | What happens |
|-------|-------------|
| App launches | Silently checks GitHub for new release after 3 seconds |
| New version found | Purple toast appears bottom-right with version number |
| Client clicks Download | Downloads in background, progress bar shows |
| Download complete | Button changes to "Restart & Install" |
| Client clicks Restart | App quits, installs update, reopens automatically |
| No new version | Nothing shown (silent) |
| Client clicks 🔄 in sidebar | Manually triggers update check |

## Notes
- Updates only work in the **packaged app** (the .exe or .dmg you send to clients)
- When running `npm start` (dev mode), clicking the update button shows "Dev Mode" message
- The update is downloaded to a temp folder and installed silently on restart
- On Windows: NSIS installer handles the update seamlessly
- On Mac: the app re-launches after update automatically
