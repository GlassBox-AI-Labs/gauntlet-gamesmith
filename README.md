# Gauntlet Gamesmith

Gauntlet Gamesmith is a desktop app that builds small browser games for you.

You type what game you want. The app then does three things, over and over:
it looks up real reference material, it writes the game, and it criticizes its
own work. Each round of criticism feeds the next round of building. You watch
the whole thing happen, and you can play the result.

The app does the work using coding assistants you already pay for — Claude Code
and Codex. It runs them on your own computer with your own login. It never sees
or stores your password.

---

## Download

**[Download the latest version](https://github.com/GlassBox-AI-Labs/gauntlet-gamesmith/releases/latest)**

Version 0.1.0 is a **Mac-only** release. Windows and Linux versions are not
built yet.

Pick the file that matches your Mac:

| Your Mac | File to download |
| --- | --- |
| Apple chip (M1, M2, M3, M4) | `Gauntlet.Gamesmith-0.1.0-mac-arm64.dmg` |
| Intel chip | `Gauntlet.Gamesmith-0.1.0-mac-x64.dmg` |

Not sure which Mac you have? Click the Apple menu in the top-left corner, then
**About This Mac**. If the chip line says "Apple", pick the Apple chip file.

Open the file you downloaded, then drag the app into your Applications folder.
The first time you open it, macOS will block it — see
[If your Mac blocks the app](#if-your-mac-blocks-the-app) below. This is
expected, and it takes about ten seconds to get past.

You do **not** need to download this code or install any developer tools to use
these files.

---

## Before you start

You need three things on your computer. All three are free to install, but one
of them needs a paid subscription to be useful.

**1. A Claude or ChatGPT subscription, and its command-line tool.**

The app drives these tools; it does not replace them. Install at least one:

```sh
npm install -g @anthropic-ai/claude-code   # for Claude
npm install -g @openai/codex               # for ChatGPT / Codex
```

You sign in to them inside the app on first launch. Your subscription pays for
the work the app does.

**2. Node.js.** Download it from [nodejs.org](https://nodejs.org/) and take the
version marked LTS. This also gives you the `npm` command used above. The app
needs Node to preview the games it builds.

**3. Git.** On a Mac, open the Terminal app, type `git --version`, and press
return — macOS will offer to install it if you don't have it. On Windows, get it
from [git-scm.com](https://git-scm.com/downloads). The app uses Git to save a
snapshot of every round, so you can go back to an earlier version of your game.

---

## First run

The first time you open the app, it walks you through setup:

1. **Welcome** — a short note on what the app does.
2. **Connect an agent** — pick Claude or Codex and sign in. A small terminal
   opens and runs that tool's own login, which usually sends you to your
   browser. The app only starts the sign-in and reads whether it worked. It
   never reads or copies your login. If the tool is not installed yet, this
   step shows you the exact command to install it.
3. **How it works** — four cards covering what happens during a run.

You can skip setup, and you can bring the tour back later from the Agents tab
("Show the tour again").

After that you land on the **Run** tab. Pick a folder for your game, describe
the game you want, and press start. Watch the rounds go by. The app stops on
its own when the critic approves the game, when it hits the round limit, when
it hits the spending limit you set, or when you press stop.

Everything stays on your machine. There is no account to create and no server to
connect to.

---

## Sharing a run with someone else

Stop the run first. Then use **Export** to copy the whole run — the game code,
the reference material it downloaded, the criticism, and the full history — into
one folder you can send. The other person uses **Import** to open that folder.
Nothing is renumbered or lost in the move.

Two things to know before you send a folder to anyone:

- **Check it first.** The export includes the raw output of the coding tools,
  exactly as they printed it. If one of them happened to echo something private
  from your computer, it is in there. Have a look before you share.
- **Imported runs are read-only.** The person you send it to can read the whole
  history, but cannot press Play or continue the run. That is on purpose: the
  app has no way to confirm that a folder from someone else is safe to execute.
  They can start a new run of their own.

---

## If your Mac blocks the app

This release is not signed with an Apple developer certificate, so macOS will
refuse to open it the first time. Nothing is wrong with the file. Here is how to
get past it:

1. Drag the app into your Applications folder first.
2. Double-click it. macOS shows a warning and refuses to open it. Click **Done**
   or **Cancel**.
3. Open **System Settings → Privacy & Security**.
4. Scroll down. You will see a line about "Gauntlet Gamesmith was blocked".
   Click **Open Anyway** next to it.
5. Confirm with your password or Touch ID.

You only have to do this once. After that the app opens normally.

If you are on an older version of macOS, you can instead right-click the app in
your Applications folder, choose **Open**, then choose **Open** again in the box
that appears.

---

## Troubleshooting

**"CLI not found" on the Agents tab.** The command-line tool for Claude or Codex
isn't installed yet, or was installed after the app was already open. Install it
with the commands above, then quit the app fully and open it again.

**The game won't preview.** Node.js is missing. Install it from
[nodejs.org](https://nodejs.org/), then restart the app.

**A run pauses and mentions a rate limit.** You've used up your subscription's
allowance for now. This is a pause, not a failure — the app waits and picks up
where it left off.

**Cost numbers.** Any dollar figure in the app is an estimate of what the same
work would cost through a pay-per-use API. It is not your real bill.

---

## For developers

Building from source, running the tests, and creating the download files are
covered in [`apps/desktop/README.md`](apps/desktop/README.md).
