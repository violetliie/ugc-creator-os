"""Seed admin users + demo creator logins. Idempotent. Run once after schema apply.

Reads the passwords from env vars to avoid hardcoding:
  ADMIN_PASSWORD       (default 'changeme-admin'  -- CHANGE THIS before real use)
  CREATOR_PASSWORD     (default 'changeme-creator' -- shared by all creator logins)

Replace the ADMINS and CREATOR_USERS lists with your own team and roster.
The demo creator ids match the fictional creators seeded by supabase/schema.sql.

Run:
  python -m worker.seed_users
"""
from __future__ import annotations
import os
import bcrypt
import logging
from .db import get_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s :: %(message)s")
log = logging.getLogger("seed")

ADMINS = [
    ("admin@example.com", "Admin"),
]

CREATOR_USERS = [
    # (email = paypal_email, creator_id, display_name)
    ("alex@example.com",   "c1000000-0000-0000-0000-000000000001", "Alex Carter"),
    ("jamie@example.com",  "c1000000-0000-0000-0000-000000000002", "Jamie Park"),
    ("riley@example.com",  "c1000000-0000-0000-0000-000000000003", "Riley Chen"),
    ("sam@example.com",    "c1000000-0000-0000-0000-000000000004", "Sam Rivera"),
    ("morgan@example.com", "c1000000-0000-0000-0000-000000000005", "Morgan Lee"),
]


def _bcrypt(p: str) -> str:
    return bcrypt.hashpw(p.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def upsert_user(db, email: str, password: str, role: str, creator_id: str | None, name: str | None):
    existing = db.table("users").select("id").eq("email", email.lower()).maybe_single().execute()
    pw = _bcrypt(password)
    if existing and existing.data:
        log.info("user exists, updating: %s", email)
        db.table("users").update({
            "password_hash": pw,
            "role": role,
            "creator_id": creator_id,
            "name": name,
            "deleted_at": None,
        }).eq("id", existing.data["id"]).execute()
    else:
        log.info("creating user: %s (%s)", email, role)
        db.table("users").insert({
            "email": email.lower(),
            "password_hash": pw,
            "role": role,
            "creator_id": creator_id,
            "name": name,
        }).execute()


def main():
    db = get_db()
    admin_pw = os.environ.get("ADMIN_PASSWORD", "changeme-admin")
    creator_pw = os.environ.get("CREATOR_PASSWORD", "changeme-creator")

    for email, name in ADMINS:
        upsert_user(db, email, admin_pw, "Admin", None, name)
    for email, creator_id, name in CREATOR_USERS:
        upsert_user(db, email, creator_pw, "Creator", creator_id, name)

    log.info("Seeded %d admins + %d creator users", len(ADMINS), len(CREATOR_USERS))


if __name__ == "__main__":
    main()
