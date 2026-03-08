# MyMultiplatform PDF Server (`/server`)

This is a real backend (Flask + Gunicorn) for:

- Login page at `/server`
- Authenticated PDF uploads (up to `40 MB`)
- Storage on Ubuntu folder: `/home/des/Desktop/mymservertest`

## Login credentials

Configured from environment variables:

- `MMSERVER_USERNAME` (requested value: `DES333888`)
- `MMSERVER_PASSWORD` (requested value: `Sexo247420@`)

Defaults are set to those values in `app.py`, but use an env file in production.

## Quick run (local)

```bash
cd pdf_server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open: `http://127.0.0.1:8090/server`

## Ubuntu deployment

From Ubuntu machine where repo exists at `/home/des/mymultiplatform.github.io`:

```bash
cd /home/des/mymultiplatform.github.io/pdf_server
chmod +x deploy/install_on_ubuntu.sh
./deploy/install_on_ubuntu.sh
```

This installs and enables:

- `mymserver.service` (Gunicorn backend on `127.0.0.1:8090`)
- `mymserver-tunnel.service` (public HTTPS tunnel via Cloudflare quick tunnel)
- `mymserver-redirect-sync.timer` (auto-updates `server.html` every 1 minute to the active tunnel URL)

Cloudflare quick tunnel hostnames are dynamic, so the sync timer keeps
`https://www.mymultiplatform.com/server` pointing to the current live tunnel URL.

Then add nginx location rules from:

`deploy/nginx_server_location.conf`

into your SSL site config for `mymultiplatform.com`, test and reload nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Notes

- Upload validation checks extension and PDF magic bytes.
- Session auth is required for dashboard, file listing, upload, and file view.
- Max file size is controlled by `MMSERVER_MAX_UPLOAD_MB` (default `40`).
- Global access depends on `mymserver-tunnel.service` and `mymserver-redirect-sync.timer`.
