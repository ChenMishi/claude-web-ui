#!/usr/bin/env python3
"""token_count.py <jsonl_path> [encoding]
Counts tokens in a JSONL file's message content.
- encoding='cl100k_base' or 'o200k_base': uses tiktoken (accurate for Claude/GPT)
- encoding='chars' or anything else: uses character-based estimate (works for all models)
"""
import json, sys

def count_tokens_tiktoken(text, encoding_name):
    try:
        import tiktoken
        enc = tiktoken.get_encoding(encoding_name)
        return len(enc.encode(text))
    except Exception:
        return count_tokens_chars(text)

def count_tokens_chars(text):
    return len(text) if text else 0

def extract_texts(block):
    """Extract all text from a content block (dict, str, or list)."""
    if isinstance(block, str):
        return [block]
    if isinstance(block, list):
        texts = []
        for item in block:
            texts.extend(extract_texts(item))
        return texts
    if not isinstance(block, dict):
        return []

    texts = []
    # Direct text/thinking fields
    for key in ('text', 'thinking'):
        val = block.get(key, '')
        if val:
            texts.append(val)

    # Any block with a 'content' field (tool_result, message content, etc.)
    c = block.get('content', '')
    if c:
        if isinstance(c, str):
            texts.append(c)
        elif isinstance(c, (list, dict)):
            texts.extend(extract_texts(c))

    # tool_use blocks: count serialized input + key text fields
    inp = block.get('input', None)
    if inp and isinstance(inp, dict):
        for key in ('content', 'command', 'prompt', 'description', 'text', 'subject',
                    'old_string', 'new_string', 'message', 'systemPrompt', 'data'):
            val = inp.get(key, '')
            if val:
                texts.append(val)
        texts.append(json.dumps(inp, ensure_ascii=False))

    return texts

jsonl_path = sys.argv[1]
encoding = sys.argv[2] if len(sys.argv) > 2 else 'chars'

total = 0
with open(jsonl_path, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
            msg = record.get('message', {})
            content = msg.get('content', '')
            texts = extract_texts(content)
            for t in texts:
                if encoding in ('cl100k_base', 'o200k_base'):
                    total += count_tokens_tiktoken(t, encoding)
                else:
                    total += count_tokens_chars(t)
        except json.JSONDecodeError:
            continue

print(total)
