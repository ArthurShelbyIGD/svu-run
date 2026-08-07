# Getting this session's work onto GitHub

The Cowork cloud sandbox can read from GitHub but cannot push to it — a known,
unresolved platform bug, not a problem with this repo or your token. So the work
is handed over as a **git bundle**: one file containing all the commits. You
apply it on your own machine and push from there.

The file is **`svu-catchup.bundle`**, already in your **Downloads** folder.
Each new bundle replaces the last, so you only ever need the newest one.

You are on Windows. Use **Git Bash** (installed with Git for Windows). If
Command Prompt says `git is not recognised`, that is why — Git for Windows does
not always add git to the system PATH, but Git Bash always works.

---

## The four lines

You do not have this repo cloned locally, so start by cloning it:

```
cd ~/Downloads
git clone https://github.com/sonicboomsoundboy/svu-run.git
cd svu-run
git fetch ~/Downloads/svu-catchup.bundle "refs/heads/*:refs/heads/*"
git push origin --all
```

GitHub Pages rebuilds itself a minute or two later.

**If you already cloned it on a previous day**, skip the clone and just run the
last two lines from inside that folder — after a `git pull` first.

---

## Then test it

```
https://sonicboomsoundboy.github.io/svu-run/svu-run.html
```

**Load it plain, with no `?q=` on the end.** Forcing a quality preset tells the
game you have made the decision and stops it adjusting itself, so you would get
the input fixes but never the low tier it now drops to automatically.

Hard-refresh once (**Ctrl+F5**) — Pages caches aggressively and you will
otherwise get yesterday's file.

---

## Checking it worked

```
git log --oneline -3
```

The top commit should be the newest one named in the handover message.

## If something goes wrong

- **"git is not recognised"** — use Git Bash from the Start menu, not Command
  Prompt.
- **"does not appear to be a git repository"** on the fetch line — the path to
  the .bundle is wrong. Drag the file into the terminal window to paste its real
  path, and keep the quotes around `refs/heads/*:refs/heads/*`.
- **"Updates were rejected"** on push — GitHub has commits the bundle does not.
  `git pull --rebase`, then push again.
- **Authentication prompt** — sign in through the browser popup, or use your
  personal access token as the password.

Nothing here can lose work. A bundle only ever *adds* commits, and if a step
fails the repo is left exactly as it was.
