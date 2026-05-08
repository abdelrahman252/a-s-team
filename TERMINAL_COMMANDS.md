# A's Team Dashboard — Terminal Commands (Mac)

## First time setup (run once)

```bash
# Install Homebrew (if not installed)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install Node.js (if not installed)
brew install node

# Install Git (if not installed)
brew install git

# Configure Git with your name & email
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

---

## Create GitHub repo & push (run once)

```bash
# Go to: https://github.com/new
# Create a NEW PRIVATE repo named: as-team-dashboard
# Do NOT add README or .gitignore (keep it empty)
# Then run:

cd /path/to/your/as-team-dashboard    # ← replace with your actual folder path

git init
git add .
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/as-team-dashboard.git
git push -u origin main
```

---

## Install dependencies locally (run once)

```bash
cd /path/to/your/as-team-dashboard
npm install
```

---

## Release a new build

```bash
cd /path/to/your/as-team-dashboard

# 1. Commit any changes
git add .
git commit -m "describe what changed"

# 2. Tag the version (change the number each release)
git tag v1.0.0

# 3. Push code + tag — triggers GitHub Actions build automatically
git push && git push --tags
```

GitHub Actions will then:
- Build Mac DMG + ZIP (Intel + Apple Silicon) — ~6–8 min
- Build Windows EXE installer + portable — ~8–10 min
- Create a GitHub Release with all files attached

Go to: `https://github.com/YOUR_USERNAME/as-team-dashboard/releases`

---

## Test locally (no build needed)

```bash
cd /path/to/your/as-team-dashboard
npm start
```

---

## Push changes without releasing

```bash
git add .
git commit -m "fix something"
git push
# No tag = no build triggered
```

---

## Version numbering

- `v1.0.0` → `v1.0.1` (small fix)
- `v1.0.0` → `v1.1.0` (new feature)
- `v1.0.0` → `v2.0.0` (big change)
