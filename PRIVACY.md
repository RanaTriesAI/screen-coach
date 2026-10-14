# Privacy

Screen Coach runs on your own PC. The makers of Screen Coach collect nothing: no account, no analytics, no tracking, no server.

## What it handles

- **Your question:** the text you type on the board.
- **One screenshot of your main screen**, taken only when you send a question. There is no timer and no watching.

## Where it is kept

Both stay on your PC, in the plugin's data folder (`~/.claude/plugins/data/screen-coach-ranatriesai/`).

- While the board is open, it keeps the files of the 3 newest questions.
- When the board closes, it moves every screenshot, question and answer to the Recycle Bin. You empty the Recycle Bin yourself.
- When you uninstall the plugin, Claude Code removes the data folder.

The board also keeps a short log (`app.log`, `log.csv`) with times, picture sizes and the number of marks. It holds no screenshot.

## Who sees it

The Claude Code chat that holds the coach reads your question and the screenshot, like any picture you paste into Claude. So they become part of your conversation with Claude and follow the privacy terms of your Claude account. Screen Coach sends them nowhere else.

A screenshot can show private things, such as messages, emails or other people's details. Close or hide them before you ask, or point the coach at a part of the screen with nothing private on it.

## Network

Screen Coach goes online only once, at the first start: npm downloads Electron 44.7.2 from the npm registry, and Electron's installer downloads the Electron program from GitHub. After that, it makes no network calls.

## Contact

Open an issue at https://github.com/RanaTriesAI/screen-coach/issues.
