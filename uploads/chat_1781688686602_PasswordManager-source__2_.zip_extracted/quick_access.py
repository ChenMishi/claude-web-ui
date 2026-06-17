"""
Quick Access — global hotkey + mini popup + auto-fill

Press the configured hotkey (default Ctrl+Shift+P) to open a search popup.
Select an entry to either copy password or auto-type credentials into the active window.

Config stored at: {VAULT_DIR}/config.json
"""

import json
import os
import sys
import time
import threading
import tkinter as tk
from tkinter import ttk, messagebox
from typing import Optional

from tree_widget import ExplorerTree

# PIL is still needed for _set_window_icon
from PIL import Image, ImageTk

# ── Platform paths ────────────────────────────────────────────────────

if sys.platform == "win32":
    CONFIG_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "PasswordManager")
else:
    CONFIG_DIR = os.path.expanduser("~/.password-manager")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")

DEFAULT_HOTKEY = "<ctrl>+<alt>+p"

# ── Hotkey helpers ────────────────────────────────────────────────────

_HOTKEY_AVAILABLE = False
_pynput_keyboard = None
_Key = None
_KeyCode = None

try:
    from pynput import keyboard as _pynput_keyboard
    from pynput.keyboard import Key as _Key, KeyCode as _KeyCode, Controller as _KbController
    _HOTKEY_AVAILABLE = True
except ImportError:
    pass


def _paste_and_fill(kc, username: str, password: str) -> None:
    """Auto-fill credentials via keyboard typing."""
    # Clear + type username
    kc.press(_Key.ctrl)
    kc.press("a")
    kc.release("a")
    kc.release(_Key.ctrl)
    time.sleep(0.03)
    kc.press(_Key.delete)
    kc.release(_Key.delete)
    time.sleep(0.05)
    kc.type(username)
    time.sleep(0.15)
    # Tab
    kc.press(_Key.tab)
    kc.release(_Key.tab)
    time.sleep(0.15)
    # Clear + type password
    kc.press(_Key.ctrl)
    kc.press("a")
    kc.release("a")
    kc.release(_Key.ctrl)
    time.sleep(0.03)
    kc.press(_Key.delete)
    kc.release(_Key.delete)
    time.sleep(0.05)
    kc.type(password)


def load_config():
    """Load config from JSON file."""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"hotkey": DEFAULT_HOTKEY}


def save_config(config: dict):
    """Save config to JSON file."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def hotkey_to_display(hk: str) -> str:
    """Convert pynput hotkey string to user-friendly display."""
    mapping = {
        "<ctrl>": "Ctrl", "<alt>": "Alt", "<shift>": "Shift",
        "<cmd>": "Win", "<super>": "Win",
    }
    parts = hk.split("+")
    out = []
    for p in parts:
        p = p.strip()
        out.append(mapping.get(p, p.upper()))
    return " + ".join(out)


# ── Icon helper ──────────────────────────────────────────────────────

def _get_icon_path():
    """Return path to icon file, handling PyInstaller bundled paths."""
    if getattr(sys, 'frozen', False):
        base = sys._MEIPASS  # type: ignore[name-defined]
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(base, "icon.ico")
    if os.path.exists(path):
        return path
    # Fallback: the EXE itself (Windows) has the icon embedded
    if sys.platform == "win32":
        exe_path = sys.executable
        if os.path.exists(exe_path):
            return exe_path
    return None


def _set_window_icon(window: tk.Toplevel):
    """Set the app icon on a Toplevel window if available (cross-platform)."""
    path = _get_icon_path()
    if path:
        try:
            window.iconbitmap(path)
        except tk.TclError:
            pass
    # iconphoto fallback — more reliable on Linux/Wayland
    try:
        img = Image.open(path)
        photo = ImageTk.PhotoImage(img)
        window.iconphoto(True, photo)
        window._icon_photo = photo  # keep ref alive
    except Exception:
        pass


# ── Recent entries ───────────────────────────────────────────────────

RECENT_MAX = 10


def load_recent():
    config = load_config()
    return config.get("recent", [])


def save_recent(recent_ids: list[str]):
    config = load_config()
    config["recent"] = recent_ids[:RECENT_MAX]
    save_config(config)


def add_recent_entry(entry_id: str):
    """Move entry_id to the top of the recent list."""
    recent = load_recent()
    if entry_id in recent:
        recent.remove(entry_id)
    recent.insert(0, entry_id)
    save_recent(recent)


# ── Quick Access Popup ────────────────────────────────────────────────


class QuickAccessPopup(tk.Toplevel):
    """Compact popup for quick search and credential access."""

    def __init__(self, parent, vault, config: dict, on_config_save):
        super().__init__(parent)
        self.vault = vault
        self.config = config
        self.on_config_save = on_config_save

        self.title("快捷访问")
        self.geometry("420x500")
        self.minsize(340, 300)
        self.attributes("-topmost", True)
        _set_window_icon(self)

        self._build_ui()
        self._refresh_list()

        # Center on screen
        self.update_idletasks()
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        w = self.winfo_width()
        h = self.winfo_height()
        self.geometry(f"+{(sw - w) // 2}+{(sh - h) // 2}")

        self.search_entry.focus_set()

        # Keyboard shortcuts
        self.bind("<Escape>", lambda e: self.destroy())
        self.bind("<Down>", lambda e: self._focus_list())

    def _build_ui(self):
        frame = ttk.Frame(self, padding=8)
        frame.pack(fill="both", expand=True)

        # ── Search bar ──
        ttk.Label(frame, text="搜索:", font=("", 10)).pack(anchor="w")
        self.search_var = tk.StringVar()
        self.search_entry = ttk.Entry(frame, textvariable=self.search_var, font=("", 10))
        self.search_entry.pack(fill="x", pady=(2, 6))
        self.search_var.trace_add("write", self._on_search)
        self.search_entry.bind("<Return>", lambda e: self._auto_fill_current())
        self.search_entry.bind("<Control-Return>", lambda e: self._auto_fill_current())

        # ── Entry list (ExplorerTree) ──
        list_frame = ttk.Frame(frame)
        list_frame.pack(fill="both", expand=True)

        self.tree = ExplorerTree(
            list_frame,
            columns=("用户名",),
            column_widths={0: 190, 1: 140},
            on_double_click=lambda iid: self._auto_fill_current(),
        )
        self.tree.pack(fill="both", expand=True)

        self.tree._canvas.bind("<Return>", lambda e: self._auto_fill_current())

        # ── Action buttons ──
        btn_frame = ttk.Frame(frame)
        btn_frame.pack(fill="x", pady=(6, 0))

        ttk.Button(btn_frame, text="自动填充 (回车)",
                   command=self._auto_fill_current).pack(side="left", padx=2)
        ttk.Button(btn_frame, text="仅复制密码",
                   command=self._copy_current).pack(side="left", padx=2)
        ttk.Button(btn_frame, text="热键设置",
                   command=self._open_hotkey_settings).pack(side="left", padx=2)
        ttk.Button(btn_frame, text="取消 (Esc)",
                   command=self.destroy).pack(side="right", padx=2)

        # Status
        self.status_var = tk.StringVar(value="回车=自动填充 | 双击=自动填充")
        ttk.Label(frame, textvariable=self.status_var, font=("", 8),
                  foreground="gray").pack(fill="x", pady=(4, 0))

    # ── Tree building (duplicated from gui.py for standalone use) ─────

    @staticmethod
    def _cat_iid(path: str) -> str:
        return f"_cat_{path}"

    def _build_category_tree(self, entries: list[dict]) -> dict:
        roots: dict[str, dict] = {}
        for entry in entries:
            cat = entry.get("category", "") or "无目录"
            parts = [p.strip() for p in cat.split("/") if p.strip()]
            if not parts:
                parts = ["无目录"]
            node = roots
            for depth, part in enumerate(parts):
                node = node.setdefault(part, {"entries": [], "children": {}})
                if depth == len(parts) - 1:
                    node["entries"].append(entry)
                node = node["children"]
        return roots

    def _populate_tree(self, tree_data: dict, parent_iid: str,
                        parent_path: str = ""):
        """Recursively add items using ExplorerTree API."""
        items = sorted(tree_data.items())
        for idx, (name, data) in enumerate(items):
            path = f"{parent_path}/{name}" if parent_path else name
            cat_iid = self._cat_iid(path)

            self.tree.add_item(cat_iid, name, parent_id=parent_iid,
                               icon="folder", is_leaf=False, is_open=True)

            for entry in data["entries"]:
                self.tree.add_item(entry["id"], entry["system_name"],
                                   parent_id=cat_iid,
                                   values=(entry["username"],),
                                   icon="key", is_leaf=True)

            self._populate_tree(data["children"], cat_iid, path)

    # ── List ──────────────────────────────────────────────────────────

    def _refresh_list(self):
        query = self.search_var.get().strip()
        self.tree.clear()

        if query:
            # Flat search mode
            entries = self.vault.search_entries(query)
            for entry in entries:
                cat = entry.get("category", "") or "无目录"
                self.tree.add_item(entry["id"], entry["system_name"],
                                   values=(f"[{cat}] {entry['username']}",),
                                   icon="key", is_leaf=True)
        else:
            # Tree mode: category tree
            all_entries = self.vault.search_entries("")
            tree_data = self._build_category_tree(all_entries)
            self._populate_tree(tree_data, "")

        self.tree.redraw()

    def _on_search(self, *_):
        self._refresh_list()

    def _focus_list(self):
        children = self.tree.get_children()
        if children:
            self.tree.set_selection(children[0])
            self.tree._canvas.focus_set()

    def _get_selected_entry(self) -> Optional[dict]:
        iid = self.tree.get_selection()
        if not iid or iid.startswith("_cat_"):
            return None
        return self.vault.get_entry(iid)

    # ── Actions ───────────────────────────────────────────────────────

    def _copy_current(self):
        """Copy password only, then close."""
        entry = self._get_selected_entry()
        if not entry:
            return
        add_recent_entry(entry["id"])
        self.clipboard_clear()
        self.clipboard_append(entry["password"])
        self.status_var.set(f"已复制密码: {entry['system_name']}")
        self.after(600, self.destroy)

    def _auto_fill_current(self):
        """Close popup, then auto-type username+password into active window."""
        entry = self._get_selected_entry()
        if not entry:
            return
        add_recent_entry(entry["id"])
        if not _HOTKEY_AVAILABLE:
            self.clipboard_clear()
            self.clipboard_append(entry["password"])
            self.status_var.set("pynput 未安装，已复制密码到剪贴板")
            self.after(800, self.destroy)
            return

        username = entry["username"]
        password = entry["password"]
        self.destroy()

        def _do_fill():
            time.sleep(0.3)
            try:
                kc = _KbController()
                _paste_and_fill(kc, username, password)
            except Exception:
                pass

        threading.Thread(target=_do_fill, daemon=True).start()

    def _open_hotkey_settings(self):
        """Open hotkey configuration dialog."""
        HotkeySettingsDialog(self, self.config, self.on_config_save)


# ── Hotkey Settings Dialog ────────────────────────────────────────────


class HotkeySettingsDialog(tk.Toplevel):
    """Dialog to configure the global hotkey."""

    def __init__(self, parent, config: dict, on_save):
        super().__init__(parent)
        self.config = config
        self.on_save = on_save
        self.title("热键设置")
        self.geometry("380x220")
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        _set_window_icon(self)

        self._build_ui()

        self.update_idletasks()
        pw, ph = parent.winfo_width(), parent.winfo_height()
        px, py = parent.winfo_rootx(), parent.winfo_rooty()
        w, h = self.winfo_width(), self.winfo_height()
        self.geometry(f"+{px + (pw - w) // 2}+{py + (ph - h) // 2}")

    def _build_ui(self):
        frame = ttk.Frame(self, padding=15)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="全局热键设置", font=("", 11, "bold")).pack(anchor="w", pady=(0, 10))

        current_hk = self.config.get("hotkey", DEFAULT_HOTKEY)
        display = hotkey_to_display(current_hk)
        ttk.Label(frame, text=f"当前热键: {display}", font=("", 10)).pack(anchor="w", pady=(0, 8))

        ttk.Label(frame, text="点击下方按钮后按下新的组合键:").pack(anchor="w", pady=(0, 4))

        self.record_btn = ttk.Button(frame, text="录制新热键", command=self._start_record)
        self.record_btn.pack(pady=(4, 4))

        self.new_key_var = tk.StringVar(value="")
        ttk.Label(frame, textvariable=self.new_key_var, font=("", 10, "bold"),
                  foreground="blue").pack(pady=(4, 8))

        btn_frame = ttk.Frame(frame)
        btn_frame.pack(fill="x", pady=(4, 0))
        ttk.Button(btn_frame, text="保存", command=self._save).pack(side="left", padx=4)
        ttk.Button(btn_frame, text="恢复默认", command=self._reset_default).pack(side="left", padx=4)
        ttk.Button(btn_frame, text="取消", command=self.destroy).pack(side="right", padx=4)

        self._recorded_keys: list[str] = []
        self._recording = False

    def _start_record(self):
        self._recorded_keys = []
        self._recording = True
        self.record_btn.config(text="正在录制... 按下组合键", state="disabled")
        self.new_key_var.set("请按下组合键...")
        self.bind("<KeyPress>", self._on_key_press)
        self.bind("<KeyRelease>", self._on_key_release)
        self.focus_set()

    def _on_key_press(self, event):
        if not self._recording:
            return
        key_name = self._key_event_to_name(event)
        if key_name and key_name not in self._recorded_keys:
            self._recorded_keys.append(key_name)
        display = "+".join(self._recorded_keys)
        self.new_key_var.set(display)
        return "break"

    def _on_key_release(self, event):
        if not self._recording:
            return
        if len(self._recorded_keys) >= 2:
            self._stop_record()
        return "break"

    def _key_event_to_name(self, event) -> str:
        """Convert tkinter key event to pynput-style key name."""
        if event.keysym in ("Control_L", "Control_R"):
            return "<ctrl>"
        if event.keysym in ("Alt_L", "Alt_R"):
            return "<alt>"
        if event.keysym in ("Shift_L", "Shift_R"):
            return "<shift>"
        if event.keysym.startswith("Super") or event.keysym == "Win_L":
            return "<cmd>"
        if len(event.keysym) == 1 and event.keysym.isalpha():
            return event.keysym.lower()
        if event.keysym in ("F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9",
                            "F10", "F11", "F12"):
            return f"<{event.keysym.lower()}>"
        if event.keysym == "space":
            return "<space>"
        return event.keysym

    def _stop_record(self):
        self._recording = False
        self.record_btn.config(text="录制新热键", state="normal")
        self.unbind("<KeyPress>")
        self.unbind("<KeyRelease>")
        if len(self._recorded_keys) < 2:
            self.new_key_var.set("组合键无效，请重试（至少包含一个修饰键+一个普通键）")
            self._recorded_keys = []
            return
        hotkey = "+".join(self._recorded_keys)
        self._recorded_keys_string = hotkey
        self.new_key_var.set(f"已录制: {hotkey_to_display(hotkey)}")

    def _save(self):
        if hasattr(self, "_recorded_keys_string") and self._recorded_keys_string:
            self.config["hotkey"] = self._recorded_keys_string
            save_config(self.config)
            self.on_save(self.config)
            messagebox.showinfo("保存成功",
                f"热键已更新为: {hotkey_to_display(self._recorded_keys_string)}\n"
                "部分情况下需要重启程序生效。")
        self.destroy()

    def _reset_default(self):
        self.config["hotkey"] = DEFAULT_HOTKEY
        save_config(self.config)
        self.on_save(self.config)
        self.new_key_var.set(f"已恢复默认: {hotkey_to_display(DEFAULT_HOTKEY)}")
        messagebox.showinfo("已恢复", "热键已恢复为默认设置")


# ── Hotkey Manager ─────────────────────────────────────────────────────


class HotkeyManager:
    """Manages global hotkey registration via pynput."""

    def __init__(self, callback, config: dict):
        self.callback = callback
        self.config = config
        self.listener = None
        self._running = False

    @property
    def available(self) -> bool:
        return _HOTKEY_AVAILABLE

    def start(self):
        if not _HOTKEY_AVAILABLE:
            return
        if self._running:
            self.stop()
        hotkey = self.config.get("hotkey", DEFAULT_HOTKEY)
        try:
            self.listener = _pynput_keyboard.GlobalHotKeys({hotkey: self.callback})
            self.listener.start()
            self._running = True
        except Exception:
            pass

    def stop(self):
        if self.listener and self._running:
            try:
                self.listener.stop()
            except Exception:
                pass
            self.listener = None
            self._running = False

    def restart(self):
        self.stop()
        self.start()
