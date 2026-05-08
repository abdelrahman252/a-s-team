# A's Team Dashboard — Commands for Windows

## Step 1 — Install tools (once)

1. **Install Node.js** → https://nodejs.org → download LTS → install it
2. **Install Git** → https://git-scm.com/download/win → install it
3. Open **Git Bash** (comes with Git — search it in Start Menu)

> Use Git Bash for ALL commands below, not PowerShell or CMD

---

## Step 2 — Create GitHub repo (once)

1. Go to https://github.com/new
2. Name it: `as-team-dashboard`
3. Set it to **Private**
4. Do NOT tick any checkboxes (no README, no .gitignore)
5. Click **Create repository**

---

## Step 3 — Push your app to GitHub (once)

Open Git Bash, then run:

```bash
cd /c/path/to/your/as-team-dashboard
# Example: cd /c/Users/Ahmed/Desktop/as-team-dashboard

git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/as-team-dashboard.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

---

## Step 4 — Release a new build (every time you want to publish)

```bash
cd /c/path/to/your/as-team-dashboard

# Commit any changes first
git add .
git commit -m "update something"

# Tag the version — change the number each release
git tag v1.0.0

# Push code + tag — this starts the build automatically
git push && git push --tags
```

GitHub Actions will then:
- Build Mac DMG (Intel + Apple Silicon) — ~8 min
- Build Windows EXE installer + portable — ~10 min
- Create a Release with all files ready to download

Go to: `https://github.com/YOUR_USERNAME/as-team-dashboard/releases`

---

## Push changes without releasing

```bash
git add .
git commit -m "fix something"
git push
# No tag = no build. Safe for work-in-progress.
```

---

## Version numbering

- `v1.0.0` → `v1.0.1` (small fix)
- `v1.0.0` → `v1.1.0` (new feature)
- `v1.0.0` → `v2.0.0` (big change)

---

## What team members do on Mac (first launch)

Since the app is not signed with an Apple certificate, Mac will show a security warning the first time only. Tell them:

> Right-click the app → click Open → click Open again

After that it works normally.
