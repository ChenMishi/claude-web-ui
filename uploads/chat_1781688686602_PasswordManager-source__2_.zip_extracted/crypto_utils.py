"""
Password Manager - Cryptographic Utilities

Uses PBKDF2-HMAC-SHA256 for key derivation (600,000 iterations, OWASP 2023)
and Fernet (AES-128-CBC + HMAC-SHA256) for authenticated encryption.
"""

import base64
import os
import secrets
import string

from cryptography.fernet import Fernet
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# OWASP 2023 recommendation: 600,000 iterations for SHA256
PBKDF2_ITERATIONS = 600_000
SALT_LENGTH = 16  # bytes


def generate_salt() -> bytes:
    """Generate a cryptographically random salt for PBKDF2."""
    return os.urandom(SALT_LENGTH)


def derive_key(master_password: str, salt: bytes) -> bytes:
    """
    Derive a 32-byte key from master_password and salt using PBKDF2-HMAC-SHA256.
    Returns a URL-safe base64-encoded Fernet key (44 characters).
    """
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
        backend=default_backend(),
    )
    key_bytes = kdf.derive(master_password.encode("utf-8"))
    # Fernet expects a URL-safe base64-encoded 32-byte key
    return base64.urlsafe_b64encode(key_bytes)


def encrypt_vault(plaintext: dict, key: bytes) -> bytes:
    """
    Encrypt a dictionary as a Fernet token.
    The dict is serialized to JSON first, then encrypted.
    Returns the Fernet token as bytes.
    """
    import json

    json_bytes = json.dumps(plaintext, ensure_ascii=False).encode("utf-8")
    f = Fernet(key)
    return f.encrypt(json_bytes)


def decrypt_vault(ciphertext: bytes, key: bytes) -> dict:
    """
    Decrypt a Fernet token back to a dictionary.
    Raises cryptography.fernet.InvalidToken if the key is wrong or data is corrupted.
    """
    import json

    f = Fernet(key)
    json_bytes = f.decrypt(ciphertext)
    return json.loads(json_bytes.decode("utf-8"))


def generate_password(
    length: int = 20,
    use_upper: bool = True,
    use_lower: bool = True,
    use_digits: bool = True,
    use_symbols: bool = True,
) -> str:
    """
    Generate a cryptographically random password.

    Args:
        length: Password length (4-128)
        use_upper: Include uppercase letters
        use_lower: Include lowercase letters
        use_digits: Include digits
        use_symbols: Include symbols

    Returns:
        A random password string.

    Raises:
        ValueError: If no character classes are selected or length < 4.
    """
    if length < 4:
        raise ValueError("Password length must be at least 4")
    if length > 128:
        raise ValueError("Password length must not exceed 128")

    # Build character pool
    pools = {}
    if use_lower:
        pools["lower"] = string.ascii_lowercase
    if use_upper:
        pools["upper"] = string.ascii_uppercase
    if use_digits:
        pools["digits"] = string.digits
    if use_symbols:
        # Exclude easily confused symbols
        pools["symbols"] = "!@#$%^&*()-_=+[]{}|;:,.<>?/~"

    if not pools:
        raise ValueError("At least one character class must be selected")

    all_chars = "".join(pools.values())

    # Generate password ensuring at least one character from each selected class
    password_chars = []
    for pool in pools.values():
        password_chars.append(secrets.choice(pool))

    # Fill remaining length with random choices from all characters
    remaining = length - len(password_chars)
    password_chars.extend(secrets.choice(all_chars) for _ in range(remaining))

    # Shuffle to avoid predictable positions
    shuffled = list(password_chars)
    # Fisher-Yates shuffle using secrets for cryptographic randomness
    for i in range(len(shuffled) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        shuffled[i], shuffled[j] = shuffled[j], shuffled[i]

    return "".join(shuffled)
