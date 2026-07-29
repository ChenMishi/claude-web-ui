#!/usr/bin/env python3
"""Count tokens in a JSONL session file.

Usage: python3 token_count.py <jsonl_path> [encoding]
Output: integer token count on stdout

Supported encodings:
  cl100k_base  - GPT-4, Claude (default)
  o200k_base   - GPT-4o
"""

import sys
import tiktoken


def count_jsonl_tokens(filepath: str, encoding: str = "cl100k_base") -> int:
    enc = tiktoken.get_encoding(encoding)
    total = 0
    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if stripped:
                total += len(enc.encode(stripped))
    return total


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 token_count.py <jsonl_path> [encoding]", file=sys.stderr)
        sys.exit(1)

    filepath = sys.argv[1]
    encoding = sys.argv[2] if len(sys.argv) > 2 else "cl100k_base"

    try:
        count = count_jsonl_tokens(filepath, encoding)
        print(count)
    except FileNotFoundError:
        print(f"File not found: {filepath}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
