# jamiesonpa.github.io

Personal site for **Pierce Jamieson, Ph.D.** — biochemist, researcher, and chemistry / biochemistry tutor.

- Live URL: <https://jamiesonpa.github.io>
- Tech: static HTML + [Tailwind CSS](https://tailwindcss.com) via CDN + a small vanilla-JS effects file. No build step required.
- Hosting: GitHub Pages (static).

---

## File layout

```
.
├── index.html              # About / landing page
├── research.html           # Publications, posters, awards, teaching
├── tutoring.html           # Chemistry & biochemistry tutoring services
├── 404.html                # Themed 404
├── .nojekyll               # Tells GitHub Pages not to run Jekyll
├── assets/
│   ├── css/custom.css      # Chemistry-themed custom styles
│   ├── js/effects.js       # Atom/bond canvas, scroll reveals, mobile nav
│   ├── images/             # Profile photo + any other site images
│   └── docs/               # Downloadable CV (PDF)
└── projects/
    └── eve-tools/          # Your existing EVE Online Tools site (see below)
```

---

## Editing the site

The site is intentionally simple — three plain HTML files.

- **Text content**: open the `.html` file you want to change in any editor and edit the visible text.
- **Tutoring rate**: in `tutoring.html`, search for `TODO: replace this block with your real hourly rate`. Replace the placeholder with something like `$75 / hr`.
- **Google Scholar / LinkedIn links**: search for the literal string `URL placeholder` or the `href="#"` on those icons in `index.html`, `research.html`, and `tutoring.html`. Replace the `#` with your real profile URLs.
- **Styling**: tweak Tailwind utility classes inline in the HTML, or add new rules to `assets/css/custom.css`.
- **Background animation density**: in `assets/js/effects.js`, the `target` value inside `makeAtoms()` controls how many atoms drift in the background.

After saving edits, just refresh in the browser. No build step.

---

## Local preview

You can open `index.html` directly in a browser, but some browsers block `fetch`-style behavior on `file://`. Easiest path is a one-line static server:

```powershell
# From the repo root
python -m http.server 8000
# then open http://localhost:8000
```

Or with Node:

```powershell
npx serve .
```

---

## Deploying — first-time integration with your existing repo

Your existing `jamiesonpa.github.io` repo currently hosts the **EVE Online Tools** page at its root. We want to:

1. Move the existing EVE Tools content into `projects/eve-tools/`.
2. Drop these new site files at the repo root.
3. Push.

### Step-by-step (PowerShell)

> Run these in a separate terminal window. They modify your real GitHub repo, so go slowly and inspect each step.

```powershell
# 1. Clone (or pull) your existing site repo somewhere outside this workspace.
cd $HOME\Desktop
git clone https://github.com/jamiesonpa/jamiesonpa.github.io.git
cd jamiesonpa.github.io

# 2. Make a branch so you can review on GitHub before merging.
git checkout -b new-site

# 3. Stage the existing EVE Tools content into projects\eve-tools\.
New-Item -ItemType Directory -Force -Path "projects\eve-tools" | Out-Null

# Move every tracked file/folder EXCEPT .git and projects\ into projects\eve-tools\.
# (Inspect first with `git ls-files` so you know exactly what will move.)
Get-ChildItem -Force | Where-Object {
    $_.Name -notin @('.git', 'projects', '.gitignore', 'README.md', '.nojekyll')
} | ForEach-Object {
    Move-Item -Path $_.FullName -Destination "projects\eve-tools\" -Force
}

# 4. Copy the NEW site files from this workspace into the repo root.
$NEW = "C:\Users\jamie\OneDrive\Desktop\jamiesonpa_github_io"
Copy-Item "$NEW\index.html"       "."
Copy-Item "$NEW\research.html"    "."
Copy-Item "$NEW\tutoring.html"    "."
Copy-Item "$NEW\404.html"         "."
Copy-Item "$NEW\.nojekyll"        "."
Copy-Item "$NEW\README.md"        "." -Force
Copy-Item "$NEW\assets"           "." -Recurse -Force

# 5. Sanity check: open the site locally before pushing.
python -m http.server 8000
# Visit http://localhost:8000  and  http://localhost:8000/projects/eve-tools/

# 6. Commit and push.
git add .
git status   # eyeball this carefully
git commit -m "Add new homepage; move EVE Tools to /projects/eve-tools/"
git push -u origin new-site

# 7. Open a Pull Request on GitHub from `new-site` → `main` (or your default branch).
#    Merge after you've previewed via the GitHub Pages branch deploy.
```

### After deploy

- `https://jamiesonpa.github.io/`                       → new homepage
- `https://jamiesonpa.github.io/research.html`          → research page
- `https://jamiesonpa.github.io/tutoring.html`          → tutoring page
- `https://jamiesonpa.github.io/projects/eve-tools/`    → existing EVE Tools, unchanged

### Heads-up about relative paths inside EVE Tools

If your existing EVE Tools HTML/JS uses **absolute paths** like `/script.js` or `/assets/foo.png`, those will break after the move because the URL prefix is now `/projects/eve-tools/`. Two ways to fix:

- **Preferred:** change those references to relative paths (e.g. `script.js` or `./assets/foo.png`).
- **Quick hack:** add a `<base href="/projects/eve-tools/">` tag inside the `<head>` of `projects/eve-tools/index.html`.

If everything in the old site already uses relative paths (`./` or just `script.js`), no change is needed.

---

## TODOs that are flagged inside the HTML

Search the repo for `TODO:` to find the small placeholders you may want to fill in:

- `tutoring.html` → hourly rate (currently "Contact for current rates")
- `index.html`, `research.html`, `tutoring.html` → Google Scholar URL (currently `#`)
- `index.html`, `research.html`, `tutoring.html` → LinkedIn URL (currently `#`)

---

## License / attribution

Content © Pierce A. Jamieson. Tailwind CSS © Tailwind Labs (MIT). Fonts from Google Fonts (IBM Plex Mono, Share Tech Mono).
