# clrk

A drop folder that files itself. Put a document in `~/Documents/Inbox` (an email
attachment, a scan, a download) and clrk reads its text, decides where it
belongs in `~/Documents` by rules you write, moves it there and records the
decision. Anything it can't place goes to `Inbox/_review` with a notification.

macOS only. Node 22, no dependencies.

## How it works

```
launchd  (WatchPaths on the Inbox, plus every 15 minutes)
  └─ Clrk.app            a tiny Swift launcher that holds the Documents permission
       └─ node bin/cli.mjs run
            ├─ wait for the file to finish arriving; skip duplicates by sha256
            ├─ extract text: pdftotext, ocrmypdf, tesseract, textutil, mdls
            ├─ claude -p, with zero tools          -> a JSON decision
            ├─ validate: inside ~/Documents, outside Inbox, confidence, new-folder cap
            ├─ move and rename; append to the docket
            └─ notify on new folders, reviews and errors
```

**The model classifies; the script acts.** Documents are untrusted input and
can carry a prompt injection. The classify call gets the document as text on
stdin and has no tools at all, so it cannot open a file, run a command or reach
the network. The worst an injection can do is misfile that one document inside
`~/Documents`, which the validator bounds and `clrk undo` reverses.

**Nothing is deleted.** Duplicates, low-confidence calls, encrypted PDFs,
images with no readable text and anything that fails three times go to the
review pile.

**Only text leaves the machine**, and only in the classify call. Images are
OCR'd locally; an image with no readable text never reaches the model.

## Commands

```
clrk run                 one pass over the Inbox (what launchd runs)
clrk classify <file>     dry run: print the decision, move nothing
clrk status              today's count, pending files, job state
clrk log [n]             the last n docket entries
clrk undo [id|last]      put a filed document back in the review pile
clrk doctor              check the permission, launcher, tools, auth and job
clrk tree                the folder tree the classifier sees
```

## Setup

1. `brew install poppler ocrmypdf tesseract`, and the `claude` CLI, logged in.
2. `launcher/build.sh` builds `~/Applications/Clrk.app`.
3. `open -W -a Clrk --args doctor` once, and allow access to Documents when
   macOS asks. The permission belongs to the app, not to your terminal.
4. Write your rules (see below) and point `rulesPath` in
   `~/Library/Application Support/clrk/config.json` at them.
5. Load a LaunchAgent that runs `Clrk.app/Contents/MacOS/Clrk run` with
   `WatchPaths` on the Inbox.

A launcher signed ad-hoc is identified by its hash, so rebuilding it drops the
Documents permission; `build.sh` refuses to overwrite one without `--replace`.
Signed with a Developer ID, a rebuild keeps it.

## Rules

The rules are a Markdown file sent as the system prompt, after fixed
instructions that the document text is data. Write them the way you would
brief a person: which folders exist, what goes in each, how to name things,
when to give up and choose review. `clrk tree` shows the folders the model
sees; `clrk classify <file>` tries a rule change without moving anything.

## Configuration

`~/Library/Application Support/clrk/config.json`, written with every default
on first run: model, rules path, daily document cap (60), confidence floor
(0.7), new-folder limit (2), text cap, OCR thresholds, timeouts.

## Tests

```
test/fixtures/make.sh    # builds sample documents (needs ImageMagick)
npm test
```

## License

AGPL-3.0-only.
