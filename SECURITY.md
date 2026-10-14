# Security

## Report a problem

Please do not open a public issue for a security problem. Report it privately on GitHub: open the **Security** tab of this repository and choose **Report a vulnerability**. We aim to answer within 7 days.

## Supported versions

Only the newest version gets fixes.

## How the board is locked down

- The board loads one local page. It cannot open other pages or new windows.
- The page runs sandboxed, with context isolation, no Node.js access and a strict Content Security Policy (scripts and styles only from its own files).
- Every browser permission request (camera, microphone, location and more) is refused.
- The main process accepts messages only from the board's own page.
- Electron is pinned to an exact version in `app/package-lock.json`, and its program is checked against the checksums that ship in the Electron package.
