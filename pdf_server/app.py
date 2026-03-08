import os
import secrets
from datetime import datetime
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    abort,
    flash,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename


BASE_ROUTE = "/server"
MAX_UPLOAD_MB = int(os.getenv("MMSERVER_MAX_UPLOAD_MB", "40"))
DEFAULT_UPLOAD_DIR = Path(
    os.getenv("MMSERVER_UPLOAD_DIR", "/home/des/Desktop/mymservertest")
).expanduser()
APP_USERNAME = os.getenv("MMSERVER_USERNAME", "DES333888")
APP_PASSWORD = os.getenv("MMSERVER_PASSWORD", "Sexo247420@")


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _ensure_upload_dir(upload_dir: Path) -> Path:
    try:
        upload_dir.mkdir(parents=True, exist_ok=True)
        return upload_dir
    except OSError:
        fallback = Path(__file__).resolve().parent / "uploads"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def _list_pdfs(upload_dir: Path):
    entries = []
    for item in upload_dir.glob("*.pdf"):
        if not item.is_file():
            continue
        stat = item.stat()
        entries.append(
            {
                "name": item.name,
                "size_mb": round(stat.st_size / (1024 * 1024), 2),
                "modified": datetime.fromtimestamp(stat.st_mtime).strftime(
                    "%Y-%m-%d %H:%M:%S"
                ),
                "_mtime": stat.st_mtime,
            }
        )
    entries.sort(key=lambda x: x["_mtime"], reverse=True)
    for entry in entries:
        entry.pop("_mtime", None)
    return entries


def _is_pdf(stream) -> bool:
    stream.seek(0)
    magic = stream.read(5)
    stream.seek(0)
    return magic == b"%PDF-"


def _next_available_name(raw_name: str, upload_dir: Path) -> str:
    safe_name = secure_filename(raw_name)
    stem = Path(safe_name).stem[:80] or "document"
    final_name = f"{stem}.pdf"
    target = upload_dir / final_name
    if not target.exists():
        return final_name

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = f"{stem}-{ts}.pdf"
    target = upload_dir / candidate
    if not target.exists():
        return candidate

    counter = 1
    while True:
        candidate = f"{stem}-{ts}-{counter}.pdf"
        target = upload_dir / candidate
        if not target.exists():
            return candidate
        counter += 1


def require_login(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login_page"))
        return view(*args, **kwargs)

    return wrapped


def create_app() -> Flask:
    app = Flask(__name__, template_folder="templates")
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
    app.config["SECRET_KEY"] = os.getenv("MMSERVER_SECRET_KEY", secrets.token_hex(32))
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["SESSION_COOKIE_SECURE"] = _bool_env("MMSERVER_COOKIE_SECURE", False)

    upload_dir = _ensure_upload_dir(Path(os.getenv("MMSERVER_UPLOAD_DIR", str(DEFAULT_UPLOAD_DIR))).expanduser())

    @app.get("/healthz")
    def healthz():
        return {"ok": True}

    @app.get(BASE_ROUTE)
    @app.get(f"{BASE_ROUTE}/")
    def login_page():
        if session.get("logged_in"):
            return redirect(url_for("dashboard"))
        return render_template("login.html", max_upload_mb=MAX_UPLOAD_MB)

    @app.post(f"{BASE_ROUTE}/login")
    def login():
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if username != APP_USERNAME or password != APP_PASSWORD:
            flash("Invalid credentials.", "error")
            return redirect(url_for("login_page"))

        session["logged_in"] = True
        session["username"] = username
        return redirect(url_for("dashboard"))

    @app.post(f"{BASE_ROUTE}/logout")
    def logout():
        session.clear()
        return redirect(url_for("login_page"))

    @app.get(f"{BASE_ROUTE}/dashboard")
    @require_login
    def dashboard():
        return render_template(
            "dashboard.html",
            username=session.get("username", APP_USERNAME),
            files=_list_pdfs(upload_dir),
            max_upload_mb=MAX_UPLOAD_MB,
            upload_dir=str(upload_dir),
        )

    @app.post(f"{BASE_ROUTE}/upload")
    @require_login
    def upload():
        file = request.files.get("pdf")
        if not file or not file.filename:
            flash("Choose a PDF file first.", "error")
            return redirect(url_for("dashboard"))

        filename = secure_filename(file.filename)
        if not filename.lower().endswith(".pdf"):
            flash("Only .pdf files are allowed.", "error")
            return redirect(url_for("dashboard"))

        if not _is_pdf(file.stream):
            flash("File does not look like a valid PDF.", "error")
            return redirect(url_for("dashboard"))

        final_name = _next_available_name(filename, upload_dir)
        destination = upload_dir / final_name
        file.save(destination)
        flash(f"Uploaded: {final_name}", "success")
        return redirect(url_for("dashboard"))

    @app.get(f"{BASE_ROUTE}/files/<path:filename>")
    @require_login
    def download(filename: str):
        if not filename.lower().endswith(".pdf"):
            abort(404)
        return send_from_directory(upload_dir, filename, as_attachment=False)

    @app.errorhandler(413)
    def too_large(_error):
        flash(f"File too large. Max size is {MAX_UPLOAD_MB} MB.", "error")
        return redirect(url_for("dashboard"))

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8090)
