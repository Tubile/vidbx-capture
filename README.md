# Vidbx capture template

Private repo: https://github.com/Tubile/vidbx-capture

Locked capture page for one business. Intake clones this repo once, fills `slots.json` per business, and runs it. One repo for every client. Do not fork per client. Do not rewrite the HTML/JS/CSS.

## Setup

1. `git clone https://github.com/Tubile/vidbx-capture.git` (private, account Tubile). Do not put customer captures in it.
2. Copy `slots.example.json` to `slots.json` and fill the business slots (`slug`, `business_name`, `ask`, `time_line`, `rerecord_line`, `result_prompt`, 1–3 `questions`, optional `incentive_line` / thank-you fields). No personal customer names or emails in slots.
3. Put the logo at `public/logos/{slug}.png`.
4. Set `logo_url` in `slots.json` to `/logos/{slug}.png`.
5. `node server.js` (listens on `8090` unless `PORT` is set). Page is `/{slug}`.
6. Start a tunnel with `../start-tunnel.sh` or:

   ```
   cloudflared --url http://127.0.0.1:8090
   ```

## Drive upload (after submit)

On a successful submit the server writes `readme.txt` + `package.json` in the session folder, returns 200 immediately, then fire-and-forget `rclone copy` of `pulse-*.mp4`, `readme.txt`, and `package.json`.

Env:

- `VIDBX_DRIVE_REMOTE` — rclone remote (default `vidbxdrive`)
- `VIDBX_DRIVE_ROOT` — parent folder (default `Vidbx/{slug}`)
- `VIDBX_SKIP_DRIVE=1` — skip upload

Destination folder: `{name}-{YYYY-MM-DD-HHmm}` under that root.

## Do not

- Copy `/data` or live customer captures into a client pack
- Hardcode another business slug in `server.js` (it rewrites `/{slots.slug}` to `/`)
