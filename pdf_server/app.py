import os
import json
import secrets
import sqlite3
from datetime import date, datetime
from functools import wraps
from pathlib import Path

from flask import (
    Flask,
    abort,
    flash,
    jsonify,
    make_response,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename


BASE_ROUTE = "/server"
RENTAS_ROUTE = "/rentas.sanchez"
RENTAS_TIJUANA_API_ROUTE = f"{BASE_ROUTE}/rentas.tijuana/api"
MAX_UPLOAD_MB = int(os.getenv("MMSERVER_MAX_UPLOAD_MB", "40"))
APP_USERNAME = os.getenv("MMSERVER_USERNAME", "DES333888")
APP_PASSWORD = os.getenv("MMSERVER_PASSWORD", "Sexo247420@")
TIJUANA_MANAGER_USERNAME = os.getenv("MMSERVER_TIJUANA_MANAGER_USERNAME", "ManagerDES01")
TIJUANA_MANAGER_PASSWORD = os.getenv("MMSERVER_TIJUANA_MANAGER_PASSWORD", "Sexo247420@")
APP_HOST = os.getenv("MMSERVER_HOST", "0.0.0.0")
APP_PORT = int(os.getenv("MMSERVER_PORT", "8090"))

ALLOWED_RENTAL_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg"}
RENTAS_TIJUANA_STATUS_OPTIONS = ("pending", "preapproved", "approved", "rejected")
RENTAS_TIJUANA_DOC_SPECS = [
    ("ine", "ine_file_json", "INE / Mexican voter ID", True),
    ("secondary_id", "secondary_id_file_json", "Secondary ID", False),
    ("residency_proof", "residency_proof_file_json", "Proof of residency", True),
    ("income_proof", "income_proof_file_json", "Proof of income", True),
]
PUBLIC_FORM_ALLOWED_ORIGINS = {
    "https://www.mymultiplatform.com",
    "https://mymultiplatform.com",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
}
BANK_OPTIONS = ["bbva", "santander", "banorte", "nu", "bancomer", "scotiabank"]
APARTMENT_OPTIONS = ["1", "2", "3", "4", "5"]
STATUS_OPTIONS = {"pending", "selected", "rejected"}
RENTAL_DOC_SPECS = [
    ("photo_id", "photo_id_file", "photo-id", "Photo ID"),
    ("second_id", "second_id_file", "second-id", "Second Proof of ID"),
    (
        "address_proof",
        "address_proof_file",
        "address-proof",
        "Proof of Current Address",
    ),
    ("income_proof", "income_proof_file", "income-proof", "Proof of Income"),
    (
        "bank_statement",
        "bank_statement_file",
        "bank-statement",
        "Bank Statement / Bank Summary",
    ),
]
DOC_KIND_TO_COLUMN = {spec[2]: spec[1] for spec in RENTAL_DOC_SPECS}


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _utc_now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def _normalize_email(raw: str) -> str:
    return raw.strip().lower()


def _default_upload_dir() -> Path:
    if os.name == "nt":
        return Path.home() / "Documents" / "mymserver_uploads"
    return Path("/home/des/Desktop/mymservertest")


def _ensure_upload_dir(upload_dir: Path) -> Path:
    try:
        upload_dir.mkdir(parents=True, exist_ok=True)
        return upload_dir
    except OSError:
        fallback = Path(__file__).resolve().parent / "uploads"
        fallback.mkdir(parents=True, exist_ok=True)
        return fallback


def _default_db_path(upload_dir: Path) -> Path:
    raw = os.getenv("MMSERVER_DB_PATH", "").strip()
    if raw:
        return Path(raw).expanduser()
    return upload_dir / "mymserver.sqlite3"


def _db_connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _ensure_columns(conn: sqlite3.Connection, table: str, columns: dict) -> None:
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    for name, ddl in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")


def _init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        _ensure_columns(
            conn,
            "rentas_tijuana_submissions",
            {
                "ine_file_json": "TEXT NOT NULL DEFAULT '{}'",
                "secondary_id_file_json": "TEXT NOT NULL DEFAULT '{}'",
                "residency_proof_file_json": "TEXT NOT NULL DEFAULT '{}'",
                "income_proof_file_json": "TEXT NOT NULL DEFAULT '{}'",
                "status": "TEXT NOT NULL DEFAULT 'pending'",
                "manager_notes": "TEXT NOT NULL DEFAULT ''",
                "apartment_unit": "TEXT NOT NULL DEFAULT ''",
                "move_in_date": "TEXT NOT NULL DEFAULT ''",
                "contract_start_date": "TEXT NOT NULL DEFAULT ''",
                "contract_end_date": "TEXT NOT NULL DEFAULT ''",
                "monthly_rent": "TEXT NOT NULL DEFAULT ''",
                "deposit_amount": "TEXT NOT NULL DEFAULT ''",
                "contract_file": "TEXT NOT NULL DEFAULT ''",
                "contract_created_at": "TEXT NOT NULL DEFAULT ''",
                "signing_status": "TEXT NOT NULL DEFAULT 'not_sent'",
                "move_in_meeting_at": "TEXT NOT NULL DEFAULT ''",
                "payment_meeting_at": "TEXT NOT NULL DEFAULT ''",
                "first_payment_due": "TEXT NOT NULL DEFAULT ''",
                "appointment_notes": "TEXT NOT NULL DEFAULT ''",
                "updated_at": "TEXT NOT NULL DEFAULT ''",
            },
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rental_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                full_name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rental_applications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL UNIQUE,
                apartment_room INTEGER NOT NULL,
                bank_name TEXT NOT NULL,
                current_address TEXT NOT NULL,
                reference_name TEXT NOT NULL,
                reference_phone TEXT NOT NULL,
                photo_id_file TEXT NOT NULL,
                second_id_file TEXT NOT NULL,
                address_proof_file TEXT NOT NULL,
                income_proof_file TEXT NOT NULL,
                bank_statement_file TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                manager_notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(user_id) REFERENCES rental_users(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS rentas_tijuana_submissions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                submission_token TEXT NOT NULL UNIQUE,
                first_name TEXT NOT NULL,
                last_name TEXT NOT NULL,
                address TEXT NOT NULL,
                city TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT '',
                postal TEXT NOT NULL DEFAULT '',
                country TEXT NOT NULL,
                email TEXT NOT NULL,
                phone TEXT NOT NULL DEFAULT '',
                dob TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                files_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )


def _list_posts(db_path: Path, limit: int = 100):
    with _db_connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, title, body, created_at
            FROM posts
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [dict(row) for row in rows]


def _create_post(db_path: Path, title: str, body: str) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO posts (title, body, created_at)
            VALUES (?, ?, ?)
            """,
            (title, body, _utc_now()),
        )


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


def _save_rental_document(file_obj, destination_dir: Path, prefix: str) -> str:
    if not file_obj or not file_obj.filename:
        raise ValueError("missing file")

    safe_name = secure_filename(file_obj.filename)
    ext = Path(safe_name).suffix.lower()
    if ext not in ALLOWED_RENTAL_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_RENTAL_EXTENSIONS))
        raise ValueError(f"allowed file types: {allowed}")

    if ext == ".pdf" and not _is_pdf(file_obj.stream):
        raise ValueError("PDF file does not look valid")

    token = secrets.token_hex(6)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_prefix = secure_filename(prefix) or "document"
    final_name = f"{safe_prefix}-{stamp}-{token}{ext}"
    file_obj.save(destination_dir / final_name)
    return final_name


def _looks_like_allowed_upload(file_obj, ext: str) -> bool:
    head = file_obj.stream.read(16)
    file_obj.stream.seek(0)
    if ext == ".pdf":
        return head.startswith(b"%PDF-")
    if ext == ".png":
        return head.startswith(b"\x89PNG\r\n\x1a\n")
    if ext in {".jpg", ".jpeg"}:
        return head.startswith(b"\xff\xd8\xff")
    return False


def _save_public_form_file(file_obj, destination_dir: Path) -> dict:
    if not file_obj or not file_obj.filename:
        raise ValueError("missing file")

    safe_name = secure_filename(file_obj.filename)
    ext = Path(safe_name).suffix.lower()
    if ext not in ALLOWED_RENTAL_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_RENTAL_EXTENSIONS))
        raise ValueError(f"allowed file types: {allowed}")

    if not _looks_like_allowed_upload(file_obj, ext):
        raise ValueError("file content does not match the allowed type")

    token = secrets.token_hex(6)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = Path(safe_name).stem[:60] or "document"
    final_name = f"{stem}-{stamp}-{token}{ext}"
    file_obj.save(destination_dir / final_name)
    return {
        "original_name": safe_name,
        "stored_name": final_name,
        "content_type": file_obj.content_type or "",
    }


def _api_response(payload: dict, status: int = 200):
    response = make_response(jsonify(payload), status)
    origin = request.headers.get("Origin", "")
    if origin in PUBLIC_FORM_ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def _safe_json(raw: str, fallback):
    try:
        return json.loads(raw) if raw else fallback
    except (TypeError, json.JSONDecodeError):
        return fallback


def _parse_iso_date(raw: str):
    try:
        return date.fromisoformat(raw)
    except (TypeError, ValueError):
        return None


def _add_months(value: date, months: int) -> date:
    month = value.month - 1 + months
    year = value.year + month // 12
    month = month % 12 + 1
    days = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
            31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return date(year, month, min(value.day, days[month - 1]))


def _spanish_date(value: str) -> str:
    parsed = _parse_iso_date(value)
    if not parsed:
        return value
    months = [
        "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
        "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
    ]
    return f"{parsed.day} de {months[parsed.month - 1]} de {parsed.year}"


def _full_name(row: dict) -> str:
    return f"{row.get('first_name', '').strip()} {row.get('last_name', '').strip()}".strip()


def _rentas_tijuana_folder(upload_dir: Path, submission_token: str) -> Path:
    return _ensure_upload_dir(
        upload_dir / "rentas_tijuana_applications" / secure_filename(submission_token)
    )


def _decorate_tijuana_submission(row: sqlite3.Row) -> dict:
    item = dict(row)
    files = _safe_json(item.get("files_json", ""), [])
    item["files"] = files
    for _, column_name, _, _ in RENTAS_TIJUANA_DOC_SPECS:
        item[column_name.replace("_json", "")] = _safe_json(item.get(column_name, ""), {})
    item["full_name"] = _full_name(item)
    return item


def _list_tijuana_submissions(db_path: Path):
    with _db_connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM rentas_tijuana_submissions
            ORDER BY
                CASE status
                    WHEN 'pending' THEN 0
                    WHEN 'preapproved' THEN 1
                    WHEN 'approved' THEN 2
                    WHEN 'rejected' THEN 3
                    ELSE 4
                END,
                id DESC
            LIMIT 300
            """
        ).fetchall()
    return [_decorate_tijuana_submission(row) for row in rows]


def _get_tijuana_submission(db_path: Path, submission_token: str):
    with _db_connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM rentas_tijuana_submissions WHERE submission_token = ?",
            (submission_token,),
        ).fetchone()
    return _decorate_tijuana_submission(row) if row else None


def _update_tijuana_review(db_path: Path, submission_token: str, values: dict) -> bool:
    with sqlite3.connect(db_path) as conn:
        cur = conn.execute(
            """
            UPDATE rentas_tijuana_submissions
            SET status = ?,
                manager_notes = ?,
                apartment_unit = ?,
                move_in_date = ?,
                contract_start_date = ?,
                contract_end_date = ?,
                monthly_rent = ?,
                deposit_amount = ?,
                signing_status = ?,
                move_in_meeting_at = ?,
                payment_meeting_at = ?,
                first_payment_due = ?,
                appointment_notes = ?,
                updated_at = ?
            WHERE submission_token = ?
            """,
            (
                values["status"],
                values["manager_notes"],
                values["apartment_unit"],
                values["move_in_date"],
                values["contract_start_date"],
                values["contract_end_date"],
                values["monthly_rent"],
                values["deposit_amount"],
                values["signing_status"],
                values["move_in_meeting_at"],
                values["payment_meeting_at"],
                values["first_payment_due"],
                values["appointment_notes"],
                _utc_now(),
                submission_token,
            ),
        )
    return cur.rowcount > 0


def _set_tijuana_contract_file(db_path: Path, submission_token: str, contract_file: str) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            UPDATE rentas_tijuana_submissions
            SET status = 'approved',
                contract_file = ?,
                contract_created_at = ?,
                updated_at = ?
            WHERE submission_token = ?
            """,
            (contract_file, _utc_now(), _utc_now(), submission_token),
        )


def _generate_tijuana_contract_pdf(submission: dict, output_dir: Path) -> str:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    start_date = submission.get("contract_start_date") or submission.get("move_in_date")
    parsed_start = _parse_iso_date(start_date) or date.today()
    end_date = submission.get("contract_end_date") or _add_months(parsed_start, 6).isoformat()
    tenant_name = submission["full_name"].upper()
    unit = submission.get("apartment_unit") or "____"
    rent = submission.get("monthly_rent") or "____"
    deposit = submission.get("deposit_amount") or rent

    filename = f"contrato-{secure_filename(submission['submission_token'])}.pdf"
    path = output_dir / filename
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="LeaseTitle", parent=styles["Title"], fontSize=14, leading=18, alignment=1))
    styles.add(ParagraphStyle(name="LeaseBody", parent=styles["BodyText"], fontSize=10.5, leading=14, spaceAfter=8))
    styles.add(ParagraphStyle(name="LeaseClause", parent=styles["BodyText"], fontSize=10.2, leading=13.5, spaceAfter=7))

    doc = SimpleDocTemplate(
        str(path),
        pagesize=letter,
        leftMargin=0.8 * inch,
        rightMargin=0.8 * inch,
        topMargin=0.72 * inch,
        bottomMargin=0.72 * inch,
    )
    story = [
        Paragraph("CONTRATO DE ARRENDAMIENTO", styles["LeaseTitle"]),
        Spacer(1, 8),
        Paragraph(
            "CON FUNDAMENTO EN EL ARTICULO 2357 DEL CODIGO CIVIL DEL ESTADO DE "
            "BAJA CALIFORNIA, CELEBRAN EL PRESENTE CONTRATO DE ARRENDAMIENTO "
            "COMO ARRENDADOR: SANCHEZ DELGADILLO DANTE ETHAN Y COMO ARRENDATARIO: "
            f"{tenant_name}, ACEPTANDO LOS TERMINOS DE LAS SIGUIENTES CLAUSULAS:",
            styles["LeaseBody"],
        ),
        Paragraph("CLAUSULAS", styles["LeaseTitle"]),
    ]

    clauses = [
        f"1.- El arrendador Sanchez Delgadillo Dante Ethan da en arrendamiento a "
        f"{submission['full_name']} el inmueble (VIVIENDA) que se encuentra en Calle Av "
        f"Aldama 7024 #{unit}, Col. Independencia, CP: 22055, en la Ciudad de Tijuana, BC.",
        f"2.- El presente contrato tendra una duracion de 6 meses a partir del dia "
        f"{_spanish_date(parsed_start.isoformat())} hasta el dia {_spanish_date(end_date)}, "
        "voluntario para ambas partes, contando a partir de que se firme el presente contrato.",
        f"3.- Se conviene expresamente en que el precio del arrendamiento sera de "
        f"${rent} MXN pagaderos mensualmente por adelantado. Ademas de un deposito de "
        f"${deposit} MXN por concepto de garantia por los danos que el inmueble pudiera sufrir "
        "al final del periodo de renta; en caso contrario, sera devuelto al arrendatario a la entrega del inmueble.",
        "4.- El arrendatario podra modificar o alterar los bienes arrendados solamente con consentimiento previo del arrendador.",
        "5.- El arrendatario queda formalmente comprometido a pagar integramente el monto de la renta por adelantado, "
        "realizando el deposito en la cuenta indicada por el arrendador o en efectivo en el domicilio del propietario.",
        "6.- El arrendatario conviene en desocupar la casa habitacion objeto del presente contrato al dia siguiente de que termine el contrato.",
        "7.- En caso de que por causas ajenas el arrendatario no pueda desocupar el inmueble en el plazo pactado y se encuentre "
        "al corriente en sus pagos, se le podra dar una prorroga pagando una contraprestacion de 10% diarios hasta desocupar el inmueble, "
        "a menos que firme un nuevo contrato que renueve sus derechos.",
        "8.- El arrendatario tiene prohibido subarrendar, traspasar o ceder sus derechos de inquilino, o realizar cualquier otro uso de la propiedad, "
        "sin consentimiento expreso y por escrito del arrendador.",
        "9.- El arrendatario no podra usar el inmueble arrendado mas que para vivienda.",
        "10.- El arrendatario reconoce que recibe la vivienda objeto del presente contrato a su entera satisfaccion.",
        "11.- Al finalizar la vigencia del presente contrato, el arrendatario debera entregar el inmueble en las mismas condiciones en las que fue entregado.",
        "12.- Las partes convienen que pueden dar por terminado el presente contrato con treinta dias de anticipacion a la fecha en que se desocupe el inmueble.",
    ]
    for clause in clauses:
        story.append(Paragraph(clause, styles["LeaseClause"]))

    story.extend([
        PageBreak(),
        Paragraph("INVENTARIO", styles["LeaseTitle"]),
        Paragraph(
            "El inmueble se encuentra en condiciones de uso, asi como las siguientes instalaciones: "
            "VIDRIOS, PUERTAS, CHAPAS, INSTALACIONES DE LUZ Y AGUA CORRIENTE.",
            styles["LeaseBody"],
        ),
        Spacer(1, 80),
        Table(
            [
                ["ARRENDADOR", "ARRENDATARIO"],
                ["Sanchez Delgadillo Dante Ethan", submission["full_name"]],
                ["Firma", "Firma"],
            ],
            colWidths=[3.1 * inch, 3.1 * inch],
            style=TableStyle([
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LINEABOVE", (0, 2), (-1, 2), 0.75, colors.black),
                ("TOPPADDING", (0, 2), (-1, 2), 28),
            ]),
        ),
        Spacer(1, 45),
        Paragraph(f"Tijuana, Baja California, {_spanish_date(parsed_start.isoformat())}", styles["LeaseBody"]),
    ])
    doc.build(story)
    return filename


def _rental_user_folder(upload_dir: Path, user_id: int) -> Path:
    return _ensure_upload_dir(upload_dir / "rental_applications" / f"user_{user_id}")


def _find_rental_user_by_email(db_path: Path, email: str):
    with _db_connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT id, full_name, email, password_hash, created_at
            FROM rental_users
            WHERE email = ?
            """,
            (email,),
        ).fetchone()
    return dict(row) if row else None


def _find_rental_user_by_id(db_path: Path, user_id: int):
    with _db_connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT id, full_name, email, password_hash, created_at
            FROM rental_users
            WHERE id = ?
            """,
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def _create_rental_user(db_path: Path, full_name: str, email: str, password: str):
    hashed = generate_password_hash(password)
    try:
        with sqlite3.connect(db_path) as conn:
            cur = conn.execute(
                """
                INSERT INTO rental_users (full_name, email, password_hash, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (full_name, email, hashed, _utc_now()),
            )
            user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        return None

    return _find_rental_user_by_id(db_path, int(user_id))


def _get_rental_application_for_user(db_path: Path, user_id: int):
    with _db_connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT id, user_id, apartment_room, bank_name, current_address,
                   reference_name, reference_phone,
                   photo_id_file, second_id_file, address_proof_file,
                   income_proof_file, bank_statement_file,
                   status, manager_notes, created_at, updated_at
            FROM rental_applications
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def _upsert_rental_application(
    db_path: Path,
    user_id: int,
    apartment_room: int,
    bank_name: str,
    current_address: str,
    reference_name: str,
    reference_phone: str,
    stored_docs: dict,
) -> None:
    now = _utc_now()
    with sqlite3.connect(db_path) as conn:
        existing = conn.execute(
            "SELECT id FROM rental_applications WHERE user_id = ?",
            (user_id,),
        ).fetchone()

        if existing:
            conn.execute(
                """
                UPDATE rental_applications
                SET apartment_room = ?,
                    bank_name = ?,
                    current_address = ?,
                    reference_name = ?,
                    reference_phone = ?,
                    photo_id_file = ?,
                    second_id_file = ?,
                    address_proof_file = ?,
                    income_proof_file = ?,
                    bank_statement_file = ?,
                    status = 'pending',
                    manager_notes = '',
                    updated_at = ?
                WHERE user_id = ?
                """,
                (
                    apartment_room,
                    bank_name,
                    current_address,
                    reference_name,
                    reference_phone,
                    stored_docs["photo_id_file"],
                    stored_docs["second_id_file"],
                    stored_docs["address_proof_file"],
                    stored_docs["income_proof_file"],
                    stored_docs["bank_statement_file"],
                    now,
                    user_id,
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO rental_applications (
                    user_id,
                    apartment_room,
                    bank_name,
                    current_address,
                    reference_name,
                    reference_phone,
                    photo_id_file,
                    second_id_file,
                    address_proof_file,
                    income_proof_file,
                    bank_statement_file,
                    status,
                    manager_notes,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)
                """,
                (
                    user_id,
                    apartment_room,
                    bank_name,
                    current_address,
                    reference_name,
                    reference_phone,
                    stored_docs["photo_id_file"],
                    stored_docs["second_id_file"],
                    stored_docs["address_proof_file"],
                    stored_docs["income_proof_file"],
                    stored_docs["bank_statement_file"],
                    now,
                    now,
                ),
            )


def _list_rental_candidates(db_path: Path):
    with _db_connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT a.id,
                   a.user_id,
                   u.full_name,
                   u.email,
                   a.apartment_room,
                   a.bank_name,
                   a.current_address,
                   a.reference_name,
                   a.reference_phone,
                   a.photo_id_file,
                   a.second_id_file,
                   a.address_proof_file,
                   a.income_proof_file,
                   a.bank_statement_file,
                   a.status,
                   a.manager_notes,
                   a.created_at,
                   a.updated_at
            FROM rental_applications a
            JOIN rental_users u ON u.id = a.user_id
            ORDER BY
                CASE a.status
                    WHEN 'pending' THEN 0
                    WHEN 'selected' THEN 1
                    WHEN 'rejected' THEN 2
                    ELSE 3
                END,
                a.updated_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def _get_rental_candidate_by_application_id(db_path: Path, application_id: int):
    with _db_connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT a.id,
                   a.user_id,
                   u.full_name,
                   u.email,
                   a.photo_id_file,
                   a.second_id_file,
                   a.address_proof_file,
                   a.income_proof_file,
                   a.bank_statement_file,
                   a.status
            FROM rental_applications a
            JOIN rental_users u ON u.id = a.user_id
            WHERE a.id = ?
            """,
            (application_id,),
        ).fetchone()
    return dict(row) if row else None


def _update_rental_candidate_status(
    db_path: Path, application_id: int, status: str, manager_notes: str
) -> bool:
    with sqlite3.connect(db_path) as conn:
        cur = conn.execute(
            """
            UPDATE rental_applications
            SET status = ?, manager_notes = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, manager_notes, _utc_now(), application_id),
        )
    return cur.rowcount > 0


def require_login(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login_page"))
        return view(*args, **kwargs)

    return wrapped


def require_tenant_login(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("tenant_user_id"):
            return redirect(url_for("rentas_login_page"))
        return view(*args, **kwargs)

    return wrapped


def require_manager_login(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("manager_logged_in"):
            return redirect(url_for("rentas_manager_login_page"))
        return view(*args, **kwargs)

    return wrapped


def require_tijuana_manager_login(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("tijuana_manager_logged_in"):
            return redirect(url_for("rentas_tijuana_manager_login_page"))
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

    upload_dir = _ensure_upload_dir(
        Path(os.getenv("MMSERVER_UPLOAD_DIR", str(_default_upload_dir()))).expanduser()
    )
    db_path = _default_db_path(upload_dir)
    _init_db(db_path)
    public_posts_api = _bool_env("MMSERVER_PUBLIC_POSTS_API", True)

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
        session.pop("logged_in", None)
        session.pop("username", None)
        return redirect(url_for("login_page"))

    @app.get(f"{BASE_ROUTE}/dashboard")
    @require_login
    def dashboard():
        return render_template(
            "dashboard.html",
            username=session.get("username", APP_USERNAME),
            files=_list_pdfs(upload_dir),
            posts=_list_posts(db_path, limit=100),
            max_upload_mb=MAX_UPLOAD_MB,
            upload_dir=str(upload_dir),
            db_path=str(db_path),
        )

    @app.post(f"{BASE_ROUTE}/posts")
    @require_login
    def create_post():
        title = request.form.get("title", "").strip()[:120]
        body = request.form.get("body", "").strip()[:5000]

        if not body:
            flash("Post content is required.", "error")
            return redirect(url_for("dashboard"))

        if not title:
            title = body.splitlines()[0].strip()[:80] or "Untitled"

        _create_post(db_path, title=title, body=body)
        flash("Post saved.", "success")
        return redirect(url_for("dashboard"))

    @app.get(f"{BASE_ROUTE}/api/posts")
    def api_posts():
        if not public_posts_api and not session.get("logged_in"):
            abort(401)
        return {"items": _list_posts(db_path, limit=100)}

    @app.post(f"{BASE_ROUTE}/upload")
    @require_login
    def upload():
        file_obj = request.files.get("pdf")
        if not file_obj or not file_obj.filename:
            flash("Choose a PDF file first.", "error")
            return redirect(url_for("dashboard"))

        filename = secure_filename(file_obj.filename)
        if not filename.lower().endswith(".pdf"):
            flash("Only .pdf files are allowed.", "error")
            return redirect(url_for("dashboard"))

        if not _is_pdf(file_obj.stream):
            flash("File does not look like a valid PDF.", "error")
            return redirect(url_for("dashboard"))

        final_name = _next_available_name(filename, upload_dir)
        destination = upload_dir / final_name
        file_obj.save(destination)
        flash(f"Uploaded: {final_name}", "success")
        return redirect(url_for("dashboard"))

    @app.get(f"{BASE_ROUTE}/files/<path:filename>")
    @require_login
    def download(filename: str):
        if not filename.lower().endswith(".pdf"):
            abort(404)
        return send_from_directory(upload_dir, filename, as_attachment=False)

    @app.get(RENTAS_ROUTE)
    @app.get(f"{RENTAS_ROUTE}/")
    def rentas_home():
        if session.get("tenant_user_id"):
            return redirect(url_for("rentas_apply_page"))
        if session.get("manager_logged_in"):
            return redirect(url_for("rentas_manager_dashboard"))
        return render_template("rentas_home.html")

    @app.get(f"{RENTAS_ROUTE}/signup")
    def rentas_signup_page():
        if session.get("tenant_user_id"):
            return redirect(url_for("rentas_apply_page"))
        return render_template(
            "rentas_auth.html",
            heading="Create Your Applicant Account",
            subheading="Use your email as username, then complete your rental profile.",
            action_url=url_for("rentas_signup"),
            submit_label="Create Account",
            show_full_name=True,
            alternate_label="Already registered? Sign in",
            alternate_url=url_for("rentas_login_page"),
        )

    @app.post(f"{RENTAS_ROUTE}/signup")
    def rentas_signup():
        full_name = request.form.get("full_name", "").strip()[:160]
        email = _normalize_email(request.form.get("email", ""))
        password = request.form.get("password", "")

        if not full_name:
            flash("Full name is required.", "error")
            return redirect(url_for("rentas_signup_page"))
        if "@" not in email or "." not in email:
            flash("A valid email is required.", "error")
            return redirect(url_for("rentas_signup_page"))
        if len(password) < 8:
            flash("Password must have at least 8 characters.", "error")
            return redirect(url_for("rentas_signup_page"))

        user = _create_rental_user(db_path, full_name=full_name, email=email, password=password)
        if not user:
            flash("That email is already registered. Please sign in.", "error")
            return redirect(url_for("rentas_login_page"))

        session["tenant_user_id"] = user["id"]
        session["tenant_email"] = user["email"]
        session["tenant_full_name"] = user["full_name"]
        flash("Account created. Complete your apartment application now.", "success")
        return redirect(url_for("rentas_apply_page"))

    @app.get(f"{RENTAS_ROUTE}/login")
    def rentas_login_page():
        if session.get("tenant_user_id"):
            return redirect(url_for("rentas_apply_page"))
        return render_template(
            "rentas_auth.html",
            heading="Tenant Sign In",
            subheading="Sign in to continue or update your apartment application.",
            action_url=url_for("rentas_login"),
            submit_label="Sign In",
            show_full_name=False,
            alternate_label="Need an account? Sign up",
            alternate_url=url_for("rentas_signup_page"),
        )

    @app.post(f"{RENTAS_ROUTE}/login")
    def rentas_login():
        email = _normalize_email(request.form.get("email", ""))
        password = request.form.get("password", "")
        user = _find_rental_user_by_email(db_path, email)

        if not user or not check_password_hash(user["password_hash"], password):
            flash("Invalid email or password.", "error")
            return redirect(url_for("rentas_login_page"))

        session["tenant_user_id"] = user["id"]
        session["tenant_email"] = user["email"]
        session["tenant_full_name"] = user["full_name"]
        return redirect(url_for("rentas_apply_page"))

    @app.post(f"{RENTAS_ROUTE}/logout")
    def rentas_logout():
        session.pop("tenant_user_id", None)
        session.pop("tenant_email", None)
        session.pop("tenant_full_name", None)
        return redirect(url_for("rentas_home"))

    @app.get(f"{RENTAS_ROUTE}/apply")
    @require_tenant_login
    def rentas_apply_page():
        user_id = int(session["tenant_user_id"])
        user = _find_rental_user_by_id(db_path, user_id)
        if not user:
            session.pop("tenant_user_id", None)
            session.pop("tenant_email", None)
            session.pop("tenant_full_name", None)
            flash("Please sign in again.", "error")
            return redirect(url_for("rentas_login_page"))

        application = _get_rental_application_for_user(db_path, user_id)
        return render_template(
            "rentas_apply.html",
            user=user,
            application=application,
            bank_options=BANK_OPTIONS,
            apartment_options=APARTMENT_OPTIONS,
            doc_specs=RENTAL_DOC_SPECS,
        )

    @app.post(f"{RENTAS_ROUTE}/apply")
    @require_tenant_login
    def rentas_apply_submit():
        user_id = int(session["tenant_user_id"])
        user = _find_rental_user_by_id(db_path, user_id)
        if not user:
            flash("Please sign in again.", "error")
            return redirect(url_for("rentas_login_page"))

        apartment_room = request.form.get("apartment_room", "").strip()
        bank_name = request.form.get("bank_name", "").strip().lower()
        current_address = request.form.get("current_address", "").strip()[:600]
        reference_name = request.form.get("reference_name", "").strip()[:140]
        reference_phone = request.form.get("reference_phone", "").strip()[:60]

        if apartment_room not in APARTMENT_OPTIONS:
            flash("Choose an apartment room from 1 to 5.", "error")
            return redirect(url_for("rentas_apply_page"))
        if bank_name not in BANK_OPTIONS:
            flash("Choose a bank from the provided list.", "error")
            return redirect(url_for("rentas_apply_page"))
        if not current_address:
            flash("Current address is required.", "error")
            return redirect(url_for("rentas_apply_page"))
        if not reference_name:
            flash("Reference name is required.", "error")
            return redirect(url_for("rentas_apply_page"))
        if not reference_phone:
            flash("Reference phone number is required.", "error")
            return redirect(url_for("rentas_apply_page"))

        existing = _get_rental_application_for_user(db_path, user_id)
        docs_dir = _rental_user_folder(upload_dir, user_id)
        stored_docs = {}

        for form_name, column_name, _, label in RENTAL_DOC_SPECS:
            incoming_file = request.files.get(form_name)
            has_new_file = bool(incoming_file and incoming_file.filename)

            if has_new_file:
                try:
                    stored_docs[column_name] = _save_rental_document(
                        incoming_file,
                        destination_dir=docs_dir,
                        prefix=form_name,
                    )
                except ValueError as exc:
                    flash(f"{label}: {exc}", "error")
                    return redirect(url_for("rentas_apply_page"))
            elif existing and existing.get(column_name):
                stored_docs[column_name] = existing[column_name]
            else:
                flash(f"{label} file is required.", "error")
                return redirect(url_for("rentas_apply_page"))

        _upsert_rental_application(
            db_path=db_path,
            user_id=user_id,
            apartment_room=int(apartment_room),
            bank_name=bank_name,
            current_address=current_address,
            reference_name=reference_name,
            reference_phone=reference_phone,
            stored_docs=stored_docs,
        )

        flash(
            "Application submitted successfully. Manager review status is now pending.",
            "success",
        )
        return redirect(url_for("rentas_apply_page"))

    @app.get(f"{RENTAS_ROUTE}/manager/login")
    def rentas_manager_login_page():
        if session.get("manager_logged_in"):
            return redirect(url_for("rentas_manager_dashboard"))
        return render_template(
            "rentas_auth.html",
            heading="Manager Dashboard Login",
            subheading="Only manager credentials are allowed on this page.",
            action_url=url_for("rentas_manager_login"),
            submit_label="Enter Manager Dashboard",
            show_full_name=False,
            alternate_label="Back to applicant home",
            alternate_url=url_for("rentas_home"),
        )

    @app.post(f"{RENTAS_ROUTE}/manager/login")
    def rentas_manager_login():
        username = request.form.get("email", "").strip()
        password = request.form.get("password", "")

        if username != APP_USERNAME or password != APP_PASSWORD:
            flash("Invalid manager credentials.", "error")
            return redirect(url_for("rentas_manager_login_page"))

        session["manager_logged_in"] = True
        session["manager_username"] = username
        return redirect(url_for("rentas_manager_dashboard"))

    @app.post(f"{RENTAS_ROUTE}/manager/logout")
    def rentas_manager_logout():
        session.pop("manager_logged_in", None)
        session.pop("manager_username", None)
        return redirect(url_for("rentas_manager_login_page"))

    @app.get(f"{RENTAS_ROUTE}/manager")
    @require_manager_login
    def rentas_manager_dashboard():
        candidates = _list_rental_candidates(db_path)
        stats = {"pending": 0, "selected": 0, "rejected": 0}
        for item in candidates:
            status = item.get("status", "pending")
            if status in stats:
                stats[status] += 1

        return render_template(
            "rentas_manager_dashboard.html",
            manager_username=session.get("manager_username", APP_USERNAME),
            candidates=candidates,
            stats=stats,
            status_options=sorted(STATUS_OPTIONS),
        )

    @app.post(f"{RENTAS_ROUTE}/manager/candidates/<int:application_id>/status")
    @require_manager_login
    def rentas_manager_candidate_status(application_id: int):
        new_status = request.form.get("status", "").strip().lower()
        manager_notes = request.form.get("manager_notes", "").strip()[:1000]

        if new_status not in STATUS_OPTIONS:
            flash("Invalid status value.", "error")
            return redirect(url_for("rentas_manager_dashboard"))

        updated = _update_rental_candidate_status(
            db_path=db_path,
            application_id=application_id,
            status=new_status,
            manager_notes=manager_notes,
        )
        if not updated:
            abort(404)

        flash(f"Candidate status updated to {new_status}.", "success")
        return redirect(url_for("rentas_manager_dashboard"))

    @app.get(f"{RENTAS_ROUTE}/manager/candidates/<int:application_id>/files/<doc_kind>")
    @require_manager_login
    def rentas_manager_file(application_id: int, doc_kind: str):
        column_name = DOC_KIND_TO_COLUMN.get(doc_kind)
        if not column_name:
            abort(404)

        candidate = _get_rental_candidate_by_application_id(db_path, application_id)
        if not candidate:
            abort(404)

        filename = candidate.get(column_name)
        if not filename:
            abort(404)

        user_folder = _rental_user_folder(upload_dir, int(candidate["user_id"]))
        return send_from_directory(user_folder, filename, as_attachment=False)

    @app.route(f"{RENTAS_TIJUANA_API_ROUTE}/applications", methods=["OPTIONS"])
    def rentas_tijuana_apply_options():
        return _api_response({}, status=204)

    @app.post(f"{RENTAS_TIJUANA_API_ROUTE}/applications")
    def rentas_tijuana_apply_submit():
        if request.form.get("website", "").strip():
            return _api_response({"ok": True}, status=202)

        required_fields = {
            "firstName": "first name",
            "lastName": "last name",
            "address": "address",
            "city": "city",
            "country": "country",
            "email": "email",
        }
        values = {name: request.form.get(name, "").strip() for name in required_fields}
        missing = [label for name, label in required_fields.items() if not values[name]]
        if missing:
            return _api_response(
                {"ok": False, "error": f"Missing required fields: {', '.join(missing)}"},
                status=400,
            )

        submission_token = secrets.token_urlsafe(12)
        submission_dir = _ensure_upload_dir(
            upload_dir / "rentas_tijuana_applications" / submission_token
        )

        stored_docs = {}
        stored_files = []
        try:
            for field_name, column_name, label, required in RENTAS_TIJUANA_DOC_SPECS:
                file_obj = request.files.get(field_name)
                if not file_obj or not file_obj.filename:
                    if required:
                        return _api_response(
                            {"ok": False, "error": f"{label} is required."},
                            status=400,
                        )
                    stored_docs[column_name] = {}
                    continue

                stored = _save_public_form_file(file_obj, submission_dir)
                stored["document_type"] = field_name
                stored["label"] = label
                stored_docs[column_name] = stored
                stored_files.append(stored)
        except ValueError as exc:
            return _api_response({"ok": False, "error": str(exc)}, status=400)

        now = _utc_now()
        with _db_connect(db_path) as conn:
            conn.execute(
                """
                INSERT INTO rentas_tijuana_submissions (
                    submission_token,
                    first_name,
                    last_name,
                    address,
                    city,
                    state,
                    postal,
                    country,
                    email,
                    phone,
                    dob,
                    username,
                    notes,
                    files_json,
                    ine_file_json,
                    secondary_id_file_json,
                    residency_proof_file_json,
                    income_proof_file_json,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    submission_token,
                    values["firstName"][:120],
                    values["lastName"][:120],
                    values["address"][:500],
                    values["city"][:120],
                    request.form.get("state", "").strip()[:120],
                    request.form.get("postal", "").strip()[:40],
                    values["country"][:120],
                    values["email"][:180],
                    request.form.get("phone", "").strip()[:80],
                    request.form.get("dob", "").strip()[:40],
                    request.form.get("username", "").strip()[:80],
                    request.form.get("notes", "").strip()[:2000],
                    json.dumps(stored_files),
                    json.dumps(stored_docs.get("ine_file_json", {})),
                    json.dumps(stored_docs.get("secondary_id_file_json", {})),
                    json.dumps(stored_docs.get("residency_proof_file_json", {})),
                    json.dumps(stored_docs.get("income_proof_file_json", {})),
                    now,
                ),
            )

        return _api_response(
            {
                "ok": True,
                "message": "Application received.",
                "submissionId": submission_token,
                "fileCount": len(stored_files),
            },
            status=201,
        )

    @app.get(f"{BASE_ROUTE}/rentas.tijuana/applications")
    @require_login
    def rentas_tijuana_applications():
        return {
            "items": _list_tijuana_submissions(db_path)
        }

    @app.get(f"{BASE_ROUTE}/rentas.tijuana/manager/login")
    def rentas_tijuana_manager_login_page():
        if session.get("tijuana_manager_logged_in"):
            return redirect(url_for("rentas_tijuana_manager"))
        return render_template(
            "rentas_tijuana_manager_login.html",
            action_url=url_for("rentas_tijuana_manager_login"),
        )

    @app.post(f"{BASE_ROUTE}/rentas.tijuana/manager/login")
    def rentas_tijuana_manager_login():
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if username != TIJUANA_MANAGER_USERNAME or password != TIJUANA_MANAGER_PASSWORD:
            flash("Invalid manager credentials.", "error")
            return redirect(url_for("rentas_tijuana_manager_login_page"))

        session["tijuana_manager_logged_in"] = True
        session["tijuana_manager_username"] = username
        return redirect(url_for("rentas_tijuana_manager"))

    @app.post(f"{BASE_ROUTE}/rentas.tijuana/manager/logout")
    def rentas_tijuana_manager_logout():
        session.pop("tijuana_manager_logged_in", None)
        session.pop("tijuana_manager_username", None)
        return redirect(url_for("rentas_tijuana_manager_login_page"))

    @app.get(f"{BASE_ROUTE}/rentas.tijuana/manager")
    @require_tijuana_manager_login
    def rentas_tijuana_manager():
        applications = _list_tijuana_submissions(db_path)
        stats = {status: 0 for status in RENTAS_TIJUANA_STATUS_OPTIONS}
        for item in applications:
            status = item.get("status", "pending")
            if status in stats:
                stats[status] += 1
        return render_template(
            "rentas_tijuana_manager.html",
            username=session.get("tijuana_manager_username", TIJUANA_MANAGER_USERNAME),
            applications=applications,
            stats=stats,
            status_options=RENTAS_TIJUANA_STATUS_OPTIONS,
            doc_specs=RENTAS_TIJUANA_DOC_SPECS,
        )

    @app.post(f"{BASE_ROUTE}/rentas.tijuana/applications/<submission_token>/review")
    @require_tijuana_manager_login
    def rentas_tijuana_review(submission_token: str):
        status = request.form.get("status", "pending").strip().lower()
        if status not in RENTAS_TIJUANA_STATUS_OPTIONS:
            flash("Invalid status.", "error")
            return redirect(url_for("rentas_tijuana_manager"))

        start_date = request.form.get("contract_start_date", "").strip()
        end_date = request.form.get("contract_end_date", "").strip()
        if start_date and not end_date:
            parsed_start = _parse_iso_date(start_date)
            if parsed_start:
                end_date = _add_months(parsed_start, 6).isoformat()

        values = {
            "status": status,
            "manager_notes": request.form.get("manager_notes", "").strip()[:1200],
            "apartment_unit": request.form.get("apartment_unit", "").strip()[:40],
            "move_in_date": request.form.get("move_in_date", "").strip()[:40],
            "contract_start_date": start_date[:40],
            "contract_end_date": end_date[:40],
            "monthly_rent": request.form.get("monthly_rent", "").strip()[:40],
            "deposit_amount": request.form.get("deposit_amount", "").strip()[:40],
            "signing_status": request.form.get("signing_status", "not_sent").strip()[:40],
            "move_in_meeting_at": request.form.get("move_in_meeting_at", "").strip()[:80],
            "payment_meeting_at": request.form.get("payment_meeting_at", "").strip()[:80],
            "first_payment_due": request.form.get("first_payment_due", "").strip()[:40],
            "appointment_notes": request.form.get("appointment_notes", "").strip()[:1200],
        }
        if not _update_tijuana_review(db_path, submission_token, values):
            abort(404)
        flash("Application review saved.", "success")
        return redirect(url_for("rentas_tijuana_manager"))

    @app.post(f"{BASE_ROUTE}/rentas.tijuana/applications/<submission_token>/contract")
    @require_tijuana_manager_login
    def rentas_tijuana_generate_contract(submission_token: str):
        submission = _get_tijuana_submission(db_path, submission_token)
        if not submission:
            abort(404)

        required = {
            "apartment_unit": "apartment/unit",
            "contract_start_date": "contract start date",
            "monthly_rent": "monthly rent",
            "deposit_amount": "deposit amount",
        }
        missing = [label for key, label in required.items() if not submission.get(key)]
        if missing:
            flash(f"Missing contract data: {', '.join(missing)}.", "error")
            return redirect(url_for("rentas_tijuana_manager"))

        contract_file = _generate_tijuana_contract_pdf(
            submission,
            _rentas_tijuana_folder(upload_dir, submission_token),
        )
        _set_tijuana_contract_file(db_path, submission_token, contract_file)
        flash("Contract PDF generated and application approved.", "success")
        return redirect(url_for("rentas_tijuana_manager"))

    @app.get(f"{BASE_ROUTE}/rentas.tijuana/applications/<submission_token>/files/<path:filename>")
    @require_tijuana_manager_login
    def rentas_tijuana_file(submission_token: str, filename: str):
        folder = upload_dir / "rentas_tijuana_applications" / secure_filename(submission_token)
        safe_filename = secure_filename(filename)
        if not safe_filename:
            abort(404)
        return send_from_directory(folder, safe_filename, as_attachment=False)

    @app.errorhandler(413)
    def too_large(_error):
        flash(f"File too large. Max size is {MAX_UPLOAD_MB} MB.", "error")
        if request.path.startswith(RENTAS_ROUTE):
            if session.get("tenant_user_id"):
                return redirect(url_for("rentas_apply_page"))
            return redirect(url_for("rentas_home"))
        return redirect(url_for("dashboard"))

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host=APP_HOST, port=APP_PORT)
