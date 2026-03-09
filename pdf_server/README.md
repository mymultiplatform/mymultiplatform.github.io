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

## Ubuntu deployment (direct, no Cloudflare)

From Ubuntu machine where repo exists at `/home/des/deploy/mymserver`:

```bash
cd /home/des/deploy/mymserver/pdf_server
chmod +x deploy/install_on_ubuntu_direct.sh
./deploy/install_on_ubuntu_direct.sh
```

This installs and enables:

- `mymserver.service` (Gunicorn backend on `127.0.0.1:8090`)
- `nginx` route for `mymultiplatform.com/server`
- Explicitly disables old Cloudflare tunnel services if they exist

It writes nginx config using:

`deploy/nginx_mymultiplatform.conf`

## Notes

- Upload validation checks extension and PDF magic bytes.
- Session auth is required for dashboard, file listing, upload, and file view.
- Max file size is controlled by `MMSERVER_MAX_UPLOAD_MB` (default `40`).
- For real global access (no tunnel), you still need:
  - Router port-forwarding (`80` and `443`) to the Ubuntu host
  - DNS `A` records for `mymultiplatform.com` and `www` to your public IP
  - HTTPS certificate (Let's Encrypt) once DNS points correctly
