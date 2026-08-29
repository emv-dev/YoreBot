---
name: downloads-organizer
description: Safely organize a Downloads folder with a reviewed plan, non-overwriting moves, and one-step undo.
version: 1.0.0
requires_tools:
  - os.fs.list
  - os.fs.glob
  - os.fs.mkdir
  - os.fs.move
dangerous: false
platforms:
  - darwin
  - linux
  - win32
---

# Organize Downloads

Organize only the Downloads folder the user explicitly connects.

## Contract

1. Inventory with `os.fs.list`. Use `.` for the connected root and relative child paths; never copy or reconstruct the displayed absolute working-directory path. Use `os.fs.glob` only when the first listing is insufficient.
2. Propose a short plan naming every new folder and every source → destination move. Do not mutate anything in the same step as the proposal.
3. Wait for the user to accept the plan.
4. Create only accepted folders with `os.fs.mkdir`, then move accepted items one at a time with `os.fs.move`. Every mutation must reach YoreBot's approval dialog.
5. Preserve each filename. Never overwrite, delete, trash, edit, write, patch, or run shell commands. If a destination exists, stop and propose a different folder or leave the item in place.
6. Record each successful source → destination pair. Summarize moved and untouched items when finished.
7. To undo, call `os.fs.move` with that successful pair reversed. Undo only moves from this run and never overwrite.

## Simple categories

Prefer a few familiar folders, created only when needed: Documents, Images, Audio, Video, Archives, and Installers. Leave uncertain files where they are and say so.

## Finish

List the Downloads folder and any changed destination folders. Report exactly what moved, what stayed, and how to request an undo.
