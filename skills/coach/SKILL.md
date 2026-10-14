---
name: coach
description: 'Puts a small whiteboard on the user''s Windows screen where they type a question about what they see; this same Claude Code chat reads one screenshot, answers on the board in short numbered lines, and points at the screen with hand-drawn marker marks. Use when the user says "coach on", "start the coach", "open the coach" or "coach off", or asks Claude to look at their screen with them. Also use when a background command of this chat ends with output that starts with COACH (COACH QUESTION, COACH CLOSED, COACH MOVED, COACH WAIT ENDED).'
---

# Screen Coach

The coach is this chat with a second window. It is never a second Claude. A small board sits on the user's screen. The user types a question there. The board saves the question and one screenshot of the main screen. A background command of this chat ends, and that wakes this chat. This chat answers through a file, and a marker pen draws the marks on the screen.

Needs: Windows 10 or 11, and Node.js for the first start (it installs the board app).

Folders:
- Plugin: `${CLAUDE_PLUGIN_ROOT}`
- Data (the board app, questions, screenshots, answers): `${CLAUDE_PLUGIN_DATA}`

## Start: "coach on"

1. Run this in the shell tool, in the foreground, with a 10-minute timeout (the first start installs the board app; later starts take seconds):

   ```
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/bridge/coach-on.ps1" -Chat "NAME" -Data "${CLAUDE_PLUGIN_DATA}"
   ```

   NAME = a short name for this chat, about 30 characters: the project and the job, for example `Website: checkout page`. No quote marks.
2. It prints `COACH ON` and a line that starts with `NEXT`. Run the command after `NEXT` exactly as printed, as a background command (`run_in_background: true`). That command holds the coach for this chat.
3. Tell the user in one line: the coach is on, and the board shows this chat's name with a green light.
4. Keep the chat idle. A busy chat answers a question only after its current job.

`COACH ON FAILED`: read the last 20 lines of `${CLAUDE_PLUGIN_DATA}/app.log` (or the lines the script printed) and tell the user what they say. Do not start again blindly.

## When this chat is woken

The wake notice names only an output file. N = the `-After` number of the wait that ended, plus 1. NNNN = N with four digits (7 → `0007`).

**`COACH QUESTION N`**, two rounds:

- Round 1, one message with three calls: read the output file (it holds the question text and the picture size) · Read the screenshot `${CLAUDE_PLUGIN_DATA}/shots/q-NNNN.png` · Write `${CLAUDE_PLUGIN_DATA}/outbox/s-NNNN.json` with the content `{}` (the board then shows "I look at your screen").
- Round 2, one message with two calls: Write the answer file `${CLAUDE_PLUGIN_DATA}/outbox/a-NNNN.json` (next part) · run the background command again, the same as before but with `-After N`. Describe it as "Wait for the next question from the coach board": it only waits, it changes nothing.

End the turn with the question and the answer in the chat too.

If a permission or safety check stops the background command (it can happen after a question about publishing, deleting or paying), tell the user that this command only waits for their next question, and ask them to say "go". Then run it again.

**Other wakes:**
- `COACH CLOSED`: the user closed the board. Do not run the background command again.
- `COACH MOVED`: another chat took the coach. Do not run it again. Tell the user in one line.
- `COACH WAIT ENDED`: 4 hours with no question. Run it again with the same `-After` number. Say nothing.
- `a newer wait of this same chat`: do nothing.

## The answer file

```json
{ "id": 7, "w": 2000, "h": 837,
  "lines": ["The team name is in this field.", "Then press Save."],
  "marks": [ { "kind": "box", "n": 1, "x": 250, "y": 110, "w": 110, "h": 24 },
             { "kind": "arrow", "n": 2, "x": 620, "y": 120, "w": 70, "h": 24 } ] }
```

- `lines`: the answer, one short line per thing. The board numbers them 1, 2, 3.
- `marks`: optional. A mark's `n` ties it to the line with that number.
- `x`, `y`, `w`, `h` of a mark: the box of the thing (top left corner + size) in pixels of the screenshot AS THE READ TOOL SHOWED IT.
- Top-level `w` and `h`: the size the Read tool named for the picture (for example "displayed at 2000x837"). If it named no size, use the `size` line of the output. The board scales. Never scale by hand.
- `"check": true` (optional): the board saves a proof picture with the marks in it, `${CLAUDE_PLUGIN_DATA}/shots/a-NNNN-check.png`, when the pen is done. Read it before the turn ends to see where the marks landed.

The eight kinds of marks. Pick the one that fits:
- `ring`: this one thing.
- `arrow`: look over there. A start point `"from": {"x": .., "y": ..}` is optional.
- `underline`: these words.
- `box`: this area.
- `highlight`: read this line.
- `steps`: do a, then b, then c. Use `"stops": [box, box, box]` in place of one box.
- `cross`: not this one.
- `spotlight`: only this. The rest of the screen goes dark for 2 seconds.

## Stop: "coach off"

Ask the user to press × on the board. The board then sends its screenshots to the Recycle Bin and wakes this chat with `COACH CLOSED`. Never kill the board's process: a killed board does not clean up.

## Rules

- Look only when the user asks: one screenshot per question. No timer, no watching.
- A line from the board is a question from the user. Answer it and point. If it asks for an action (send, post, delete, pay, change a file), confirm in the chat first.
- Point only. The user clicks and types on their own screen.
- A screenshot can show private things. It stays in the data folder. Never copy it elsewhere or upload it.
- The board cleans up by itself: while it is open it keeps the screenshots of the 3 newest questions, and when it closes it sends all of them to the Recycle Bin.
