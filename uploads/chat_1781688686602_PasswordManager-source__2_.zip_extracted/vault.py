"""
Password Manager - Vault Data Management

Handles all CRUD operations, search, and persistence of password entries.
The vault is encrypted at rest and only exists in plaintext in memory.
"""

import base64
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from crypto_utils import decrypt_vault, derive_key, encrypt_vault, generate_salt


class Vault:
    """In-memory password vault with persistence to an encrypted file."""

    def __init__(self):
        self.entries: list[dict] = []
        self.categories: list[str] = []  # standalone category paths, independent of entries
        self.dirty: bool = False
        self._salt: Optional[bytes] = None
        self._key: Optional[bytes] = None

    # ── Factory / Persistence ──────────────────────────────────────────

    @classmethod
    def create(cls, filepath: str, master_password: str) -> "Vault":
        """
        Create a new empty vault, encrypt it, and save to filepath.
        Returns the unlocked Vault instance.
        """
        salt = generate_salt()
        key = derive_key(master_password, salt)
        vault = cls()
        vault._salt = salt
        vault._key = key
        vault.save(filepath)
        return vault

    @classmethod
    def load(cls, filepath: str, master_password: str) -> "Vault":
        """
        Load and decrypt a vault from filepath.
        Raises InvalidToken if master_password is wrong.
        Raises FileNotFoundError if vault file doesn't exist.
        """
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)

        salt = base64.urlsafe_b64decode(raw["salt"])
        ciphertext = base64.urlsafe_b64decode(raw["data"])

        key = derive_key(master_password, salt)
        decrypted = decrypt_vault(ciphertext, key)

        vault = cls()
        vault._salt = salt
        vault._key = key
        vault.entries = decrypted.get("entries", [])
        vault.categories = decrypted.get("categories", [])  # backward compat: old vaults have no categories key
        vault.dirty = False
        return vault

    def save(self, filepath: str) -> None:
        """Encrypt and persist the vault to filepath (atomic write)."""
        if self._key is None or self._salt is None:
            raise RuntimeError("Vault is not initialized with a key")

        plaintext = {"entries": self.entries, "categories": self.categories}
        ciphertext = encrypt_vault(plaintext, self._key)

        payload = {
            "salt": base64.urlsafe_b64encode(self._salt).decode("ascii"),
            "data": base64.urlsafe_b64encode(ciphertext).decode("ascii"),
        }

        # Atomic write: write to temp file, then rename
        tmp_path = filepath + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, filepath)
        except Exception:
            # Clean up temp file on failure
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise

        self.dirty = False

    def change_password(self, new_password: str) -> None:
        """Re-key the vault with a new master password. Vault must be unlocked."""
        if self._key is None:
            raise RuntimeError("Vault is locked, cannot change password")
        new_salt = generate_salt()
        new_key = derive_key(new_password, new_salt)
        self._salt = new_salt
        self._key = new_key
        self.dirty = True

    def lock(self) -> None:
        """Clear sensitive data from memory."""
        self.entries.clear()
        self.categories.clear()
        self.dirty = False
        self._salt = None
        self._key = None

    @property
    def is_locked(self) -> bool:
        return self._key is None

    @property
    def key(self) -> Optional[bytes]:
        return self._key

    @property
    def salt(self) -> Optional[bytes]:
        return self._salt

    # ── CRUD Operations ────────────────────────────────────────────────

    def add_entry(
        self,
        system_name: str,
        url: str,
        username: str,
        password: str,
        notes: str = "",
        category: str = "",
    ) -> str:
        """
        Add a new entry to the vault. Returns the new entry's ID.
        """
        now = datetime.now(timezone.utc).isoformat()
        entry = {
            "id": str(uuid.uuid4()),
            "system_name": system_name,
            "url": url,
            "username": username,
            "password": password,
            "notes": notes,
            "category": category,
            "created_at": now,
            "updated_at": now,
        }
        self.entries.append(entry)
        self.dirty = True
        return entry["id"]

    def update_entry(self, entry_id: str, **fields) -> None:
        """
        Update fields of an existing entry.
        Raises KeyError if entry_id is not found.
        """
        entry = self._find_by_id(entry_id)
        allowed = {"system_name", "url", "username", "password", "notes", "category"}
        for field, value in fields.items():
            if field in allowed:
                entry[field] = value
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        self.dirty = True

    def delete_entry(self, entry_id: str) -> None:
        """
        Delete an entry by ID.
        Raises KeyError if entry_id is not found.
        """
        entry = self._find_by_id(entry_id)
        self.entries.remove(entry)
        self.dirty = True

    # ── Category management ────────────────────────────────────────────

    def add_category(self, path: str) -> None:
        """Add a standalone category path. Does nothing if it already exists."""
        path = path.strip()
        if not path:
            return
        if path not in self.categories:
            self.categories.append(path)
            self.dirty = True

    def delete_category(self, path: str) -> None:
        """Delete a category and all entries whose category starts with path (exact or prefix/)."""
        # Remove the category itself
        if path in self.categories:
            self.categories.remove(path)
            self.dirty = True
        # Also remove any child categories (path/xxx)
        prefix = path + "/"
        self.categories = [c for c in self.categories
                           if c != path and not c.startswith(prefix)]
        # Remove all entries under this category
        to_delete = [e for e in self.entries
                     if (e.get("category", "") or "").startswith(path)]
        for entry in to_delete:
            self.entries.remove(entry)
        if to_delete:
            self.dirty = True

    def rename_category(self, old_path: str, new_path: str) -> None:
        """Rename a category path and update all entries/child-categories under it."""
        old_path = old_path.strip()
        new_path = new_path.strip()
        if not old_path or not new_path or old_path == new_path:
            return

        # Rename the category itself
        if old_path in self.categories:
            self.categories.remove(old_path)
            if new_path not in self.categories:
                self.categories.append(new_path)
            self.dirty = True

        # Rename child categories
        old_prefix = old_path + "/"
        new_cats = []
        for c in self.categories:
            if c == old_path:
                continue
            if c.startswith(old_prefix):
                new_cats.append(new_path + "/" + c[len(old_prefix):])
            else:
                new_cats.append(c)
        self.categories = new_cats

        # Rename entries
        for entry in self.entries:
            cat = entry.get("category", "") or ""
            if cat == old_path:
                entry["category"] = new_path
                self.dirty = True
            elif cat.startswith(old_prefix):
                entry["category"] = new_path + "/" + cat[len(old_prefix):]
                self.dirty = True

    # ── Queries ─────────────────────────────────────────────────────

    def get_entry(self, entry_id: str) -> Optional[dict]:
        """Get an entry by ID, or None if not found."""
        try:
            return self._find_by_id(entry_id)
        except KeyError:
            return None

    def get_categories(self) -> list[str]:
        """Return sorted list of unique categories (from entries + standalone)."""
        cats = set(self.categories)
        for entry in self.entries:
            c = entry.get("category", "")
            if c:
                cats.add(c)
        return sorted(cats)

    def search_entries(self, query: str, category: str = "") -> list[dict]:
        """
        Search entries by system_name, url, username, or category.
        Case-insensitive substring match.
        If category is given, only return entries in that category.
        Returns all entries if both query and category are empty.
        """
        results = self.entries

        if category:
            results = [e for e in results if e.get("category", "") == category]

        if query.strip():
            q = query.lower()
            results = [
                e for e in results
                if q in e["system_name"].lower()
                or q in e["url"].lower()
                or q in e["username"].lower()
                or q in e.get("category", "").lower()
            ]

        return list(results)

    def _find_by_id(self, entry_id: str) -> dict:
        """Find an entry by ID. Raises KeyError if not found."""
        for entry in self.entries:
            if entry["id"] == entry_id:
                return entry
        raise KeyError(f"Entry not found: {entry_id}")
