"""
Password Manager — Simple tkinter/ttk UI
"""

import json
import os
import sys
import shutil
import threading
import time
import webbrowser
import tkinter as tk
from tkinter import ttk, messagebox, filedialog, simpledialog
from datetime import datetime, timedelta, timezone
from typing import Optional

from crypto_utils import generate_password as gen_pwd
from vault import Vault
from quick_access import HotkeyManager, QuickAccessPopup, load_config as qa_load_config
from quick_access import save_config as qa_save_config, hotkey_to_display
from tree_widget import ExplorerTree, ItemInfo

from PIL import Image, ImageTk

# pynput for auto-fill (optional)
try:
    from pynput.keyboard import Key as _PynputKey, Controller as _PynputController
    _PYNPUT_AVAILABLE = True
except ImportError:
    _PYNPUT_AVAILABLE = False


def _paste_and_fill(kc, username: str, password: str) -> None:
    """Auto-fill credentials via keyboard typing."""
    # Clear + type username
    kc.press(_PynputKey.ctrl)
    kc.press("a")
    kc.release("a")
    kc.release(_PynputKey.ctrl)
    time.sleep(0.03)
    kc.press(_PynputKey.delete)
    kc.release(_PynputKey.delete)
    time.sleep(0.05)
    kc.type(username)
    time.sleep(0.15)
    # Tab
    kc.press(_PynputKey.tab)
    kc.release(_PynputKey.tab)
    time.sleep(0.15)
    # Clear + type password
    kc.press(_PynputKey.ctrl)
    kc.press("a")
    kc.release("a")
    kc.release(_PynputKey.ctrl)
    time.sleep(0.03)
    kc.press(_PynputKey.delete)
    kc.release(_PynputKey.delete)
    time.sleep(0.05)
    kc.type(password)


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


# ── Constants ──────────────────────────────────────────────────────────

if sys.platform == "win32":
    VAULT_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "PasswordManager")
else:
    VAULT_DIR = os.path.expanduser("~/.password-manager")
VAULT_FILE = os.path.join(VAULT_DIR, "vault.enc")
LOCKOUT_FILE = os.path.join(VAULT_DIR, "lockout.json")

CLIPBOARD_CLEAR_DELAY = 30_000
AUTO_LOCK_DELAY = 300_000
SEARCH_DEBOUNCE = 150
MIN_PASSWORD_LENGTH = 8


def ensure_vault_dir():
    os.makedirs(VAULT_DIR, exist_ok=True)
    if sys.platform != "win32":
        os.chmod(VAULT_DIR, 0o700)


# ── Lockout Management ─────────────────────────────────────────────────

def load_lockout():
    if os.path.exists(LOCKOUT_FILE):
        try:
            with open(LOCKOUT_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"failed_attempts": 0, "lock_until": None, "lockout_count": 0}


def save_lockout(state: dict):
    os.makedirs(VAULT_DIR, exist_ok=True)
    with open(LOCKOUT_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)


def is_locked_out():
    state = load_lockout()
    if state.get("lock_until"):
        try:
            lock_until = datetime.fromisoformat(state["lock_until"])
            now = datetime.now(timezone.utc)
            if now < lock_until:
                return True, int((lock_until - now).total_seconds())
        except Exception:
            pass
    return False, 0


def record_failed_attempt():
    state = load_lockout()
    state["failed_attempts"] = state.get("failed_attempts", 0) + 1
    if state["failed_attempts"] >= 5:
        count = state.get("lockout_count", 0)
        lock_minutes = 5 + count * 5
        lock_until = datetime.now(timezone.utc) + timedelta(minutes=lock_minutes)
        state["lock_until"] = lock_until.isoformat()
        state["lockout_count"] = count + 1
        state["failed_attempts"] = 0
        save_lockout(state)
        return True, lock_minutes
    save_lockout(state)
    return False, 0


def record_successful_unlock():
    save_lockout({"failed_attempts": 0, "lock_until": None, "lockout_count": 0})


# ── Password Generator Dialog ──────────────────────────────────────────

class PasswordGeneratorDialog(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.result: Optional[str] = None
        self.title("生成密码")
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        _set_window_icon(self)
        self._build_ui()
        self._generate()
        self._center_on(parent)

    def _center_on(self, parent):
        self.update_idletasks()
        pw, ph = parent.winfo_width(), parent.winfo_height()
        px, py = parent.winfo_rootx(), parent.winfo_rooty()
        w, h = self.winfo_width(), self.winfo_height()
        self.geometry(f"+{px + (pw - w) // 2}+{py + (ph - h) // 2}")

    def _build_ui(self):
        f = ttk.Frame(self, padding=15)
        f.pack(fill="both", expand=True)

        ttk.Label(f, text="密码生成器", font=("", 13, "bold")).pack(anchor="w", pady=(0, 10))

        row1 = ttk.Frame(f)
        row1.pack(fill="x", pady=2)
        ttk.Label(row1, text="长度:").pack(side="left")
        self.length_var = tk.IntVar(value=20)
        ttk.Spinbox(row1, from_=4, to=64, textvariable=self.length_var, width=6).pack(
            side="left", padx=5)

        ttk.Label(f, text="字符类型", font=("", 10, "bold")).pack(anchor="w", pady=(10, 2))
        self.upper_var = tk.BooleanVar(value=True)
        self.lower_var = tk.BooleanVar(value=True)
        self.digits_var = tk.BooleanVar(value=True)
        self.symbols_var = tk.BooleanVar(value=True)
        for var, txt in [(self.upper_var, "大写字母 A-Z"), (self.lower_var, "小写字母 a-z"),
                         (self.digits_var, "数字 0-9"), (self.symbols_var, "符号 !@#$...")]:
            ttk.Checkbutton(f, text=txt, variable=var).pack(anchor="w")

        ttk.Label(f, text="生成的密码:", font=("", 10, "bold")).pack(anchor="w", pady=(10, 2))
        self.password_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.password_var, font=("Courier", 10),
                  state="readonly").pack(fill="x", pady=2)

        btn = ttk.Frame(f)
        btn.pack(fill="x", pady=(12, 0))
        ttk.Button(btn, text="重新生成", command=self._generate).pack(side="left", padx=3)
        ttk.Button(btn, text="使用", command=self._use).pack(side="left", padx=3)
        ttk.Button(btn, text="取消", command=self.destroy).pack(side="right", padx=3)

        self.bind("<Control-g>", lambda e: self._generate())
        self.bind("<Return>", lambda e: self._use())
        self.bind("<Escape>", lambda e: self.destroy())

    def _generate(self):
        try:
            pwd = gen_pwd(length=self.length_var.get(), use_upper=self.upper_var.get(),
                          use_lower=self.lower_var.get(), use_digits=self.digits_var.get(),
                          use_symbols=self.symbols_var.get())
            self.password_var.set(pwd)
            self.result = pwd
        except ValueError as e:
            self.password_var.set(str(e))

    def _use(self):
        if self.result and len(self.result) >= 4:
            self.destroy()


# ── Category Picker Dialog ─────────────────────────────────────────────

class CategoryPickerDialog(tk.Toplevel):
    """Simple dialog to pick a destination category for moving entries."""

    def __init__(self, parent, paths: list[str], current: str, item_label: str = "入口"):
        super().__init__(parent)
        self.result: Optional[str] = None
        self.title("选择目标目录")
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        _set_window_icon(self)
        self._build_ui(paths, current, item_label)
        self._center_on(parent)

    def _center_on(self, parent):
        self.update_idletasks()
        pw, ph = parent.winfo_width(), parent.winfo_height()
        px, py = parent.winfo_rootx(), parent.winfo_rooty()
        w, h = self.winfo_width(), self.winfo_height()
        self.geometry(f"+{px + (pw - w) // 2}+{py + (ph - h) // 2}")

    def _build_ui(self, paths: list[str], current: str, item_label: str = "入口"):
        f = ttk.Frame(self, padding=15)
        f.pack(fill="both", expand=True)

        ttk.Label(f, text=f"将{item_label}移动到:", font=("", 11, "bold")).pack(anchor="w", pady=(0, 8))

        list_frame = ttk.Frame(f)
        list_frame.pack(fill="both", expand=True)

        self.listbox = tk.Listbox(list_frame, font=("", 10), width=35, height=12,
                                  exportselection=False)
        scroll = ttk.Scrollbar(list_frame, orient="vertical", command=self.listbox.yview)
        self.listbox.configure(yscrollcommand=scroll.set)
        self.listbox.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")

        for p in paths:
            self.listbox.insert("end", p)
            if p == current:
                idx = self.listbox.size() - 1
                self.listbox.selection_set(idx)
                self.listbox.see(idx)

        self.listbox.bind("<Double-Button-1>", lambda e: self._ok())
        self.listbox.bind("<Return>", lambda e: self._ok())

        btn = ttk.Frame(f)
        btn.pack(fill="x", pady=(10, 0))
        ttk.Button(btn, text="确定", command=self._ok).pack(side="left", padx=3)
        ttk.Button(btn, text="取消", command=self.destroy).pack(side="right", padx=3)

    def _ok(self):
        sel = self.listbox.curselection()
        if sel:
            self.result = self.listbox.get(sel[0])
        self.destroy()


# ── Login Frame ────────────────────────────────────────────────────────

class LoginFrame(ttk.Frame):
    def __init__(self, parent, on_unlock, on_create, vault_file, config):
        super().__init__(parent)
        self.on_unlock = on_unlock
        self.on_create = on_create
        self.vault_file = vault_file
        self.config = config
        self._is_create_mode = False
        self._lockout_timer_id: Optional[str] = None
        self._build_ui()

    def _build_ui(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)

        card = ttk.LabelFrame(self, text="密码管理器", padding=25)
        card.grid(row=0, column=0, padx=40, pady=40)

        ttk.Label(card, text="安全 · 本地 · 简单", font=("", 10)).pack(pady=(0, 15))

        self.status_label = ttk.Label(card, text="", font=("", 10), wraplength=300)
        self.status_label.pack(pady=(0, 10))

        ttk.Label(card, text="主密码:", font=("", 10)).pack(anchor="w", pady=(0, 2))
        self.password_var = tk.StringVar()
        self.password_entry = ttk.Entry(card, textvariable=self.password_var,
                                        show="*", font=("", 10), width=34)
        self.password_entry.pack(fill="x", pady=(0, 8))
        self.password_entry.bind("<Return>", lambda e: self._on_enter())

        # Confirm password (hidden initially)
        self.confirm_frame = ttk.Frame(card)
        self.confirm_label = ttk.Label(self.confirm_frame, text="确认密码:", font=("", 10))
        self.confirm_var = tk.StringVar()
        self.confirm_entry = ttk.Entry(self.confirm_frame, textvariable=self.confirm_var,
                                       show="*", font=("", 10), width=34)
        self.confirm_entry.bind("<Return>", lambda e: self._try_create())

        # Custom path (hidden initially)
        self.path_frame = ttk.Frame(card)
        self.path_label = ttk.Label(self.path_frame, text="存储路径:", font=("", 10))
        self.path_var = tk.StringVar()
        path_row = ttk.Frame(self.path_frame)
        self.path_entry = ttk.Entry(path_row, textvariable=self.path_var,
                                    font=("", 10), width=28)
        self.path_entry.pack(side="left")
        self.path_btn = ttk.Button(path_row, text="浏览", command=self._browse_path)
        self.path_btn.pack(side="left", padx=3)
        path_row.pack(fill="x")

        # Error
        self.error_var = tk.StringVar()
        self.error_label = ttk.Label(card, textvariable=self.error_var,
                                     foreground="red", font=("", 10))
        self.error_label.pack(pady=(6, 6))

        # Buttons
        btn_frame = ttk.Frame(card)
        btn_frame.pack(pady=(4, 0))
        self.unlock_btn = ttk.Button(btn_frame, text="解锁", command=self._try_unlock, width=14)
        self.unlock_btn.pack(side="left", padx=3)
        self.create_btn = ttk.Button(btn_frame, text="新建密码库", command=self._toggle_create_mode, width=14)
        self.create_btn.pack(side="left", padx=3)

    def _browse_path(self):
        path = filedialog.askdirectory(title="选择密码库存储目录")
        if path:
            self.path_var.set(os.path.join(path, "vault.enc"))

    def _on_enter(self):
        locked, _ = is_locked_out()
        if locked:
            return
        if os.path.exists(self.vault_file):
            self._try_unlock()
        else:
            if not self._is_create_mode:
                self._enter_create_mode()
            else:
                self._try_create()

    def _toggle_create_mode(self):
        if os.path.exists(self.vault_file):
            messagebox.showinfo("提示",
                f"密码库已存在，如需重建请先删除：\n{self.vault_file}")
            return
        if self._is_create_mode:
            self._exit_create_mode()
        else:
            self._enter_create_mode()

    def _enter_create_mode(self):
        self._is_create_mode = True
        self._show_confirm()
        self._show_path()
        self.status_label.config(text="设置主密码并选择存储位置")
        self.unlock_btn.config(text="确认创建", command=self._try_create)
        self.create_btn.config(text="取消")
        self.error_var.set("")
        self.password_var.set("")
        self.confirm_var.set("")
        self.path_var.set(self.vault_file)
        self.password_entry.focus_set()

    def _exit_create_mode(self):
        self._is_create_mode = False
        self._hide_confirm()
        self._hide_path()
        self.status_label.config(text="请输入主密码解锁")
        self.unlock_btn.config(text="解锁", command=self._try_unlock)
        self.create_btn.config(text="新建密码库")
        self.error_var.set("")
        self.password_var.set("")
        self.confirm_var.set("")
        self.password_entry.focus_set()

    def set_state(self, vault_exists: bool, message: str = ""):
        self._is_create_mode = False
        self._hide_confirm()
        self._hide_path()
        if vault_exists:
            self.status_label.config(text=message or "请输入主密码解锁")
            self.unlock_btn.config(text="解锁", command=self._try_unlock, state="normal")
            self.create_btn.config(text="新建密码库")
            self._check_lockout()
        else:
            self.status_label.config(text=message or "首次使用，请创建密码库")
            self.create_btn.config(text="创建密码库")
            self._enter_create_mode()
        self.error_var.set("")
        self.password_var.set("")
        self.confirm_var.set("")
        self.password_entry.focus_set()

    def _check_lockout(self):
        locked, remaining = is_locked_out()
        if locked:
            m, s = divmod(remaining, 60)
            self.error_var.set(f"已锁定，请 {m}分{s}秒 后重试")
            self.password_entry.config(state="disabled")
            self.unlock_btn.config(state="disabled")
            self._update_lockout_countdown(remaining)
        else:
            self.password_entry.config(state="normal")
            self.unlock_btn.config(state="normal")
            if self._lockout_timer_id:
                self.after_cancel(self._lockout_timer_id)
                self._lockout_timer_id = None

    def _update_lockout_countdown(self, remaining: int):
        if remaining <= 0:
            self.error_var.set("")
            self.password_entry.config(state="normal")
            self.unlock_btn.config(state="normal")
            self._lockout_timer_id = None
            return
        m, s = divmod(remaining, 60)
        self.error_var.set(f"已锁定，请 {m}分{s}秒 后重试")
        self._lockout_timer_id = self.after(1000, lambda: self._update_lockout_countdown(remaining - 1))

    def _show_confirm(self):
        self.confirm_label.pack(anchor="w", pady=(6, 2))
        self.confirm_entry.pack(fill="x", pady=(0, 6))
        self.confirm_frame.pack(fill="x", before=self.error_label)

    def _hide_confirm(self):
        self.confirm_frame.pack_forget()

    def _show_path(self):
        self.path_label.pack(anchor="w", pady=(2, 2))
        self.path_frame.pack(fill="x", before=self.error_label)

    def _hide_path(self):
        self.path_frame.pack_forget()

    def _try_unlock(self):
        locked, _ = is_locked_out()
        if locked:
            self._check_lockout()
            return
        if not os.path.exists(self.vault_file):
            self.error_var.set("密码库不存在，请先创建")
            return
        password = self.password_var.get()
        if not password:
            self.error_var.set("请输入主密码")
            return
        self.error_var.set("")
        self.on_unlock(password)

    def _try_create(self):
        password = self.password_var.get()
        confirm = self.confirm_var.get()
        if len(password) < MIN_PASSWORD_LENGTH:
            self.error_var.set(f"主密码至少需要 {MIN_PASSWORD_LENGTH} 个字符")
            return
        if password != confirm:
            self.error_var.set("两次输入的密码不一致")
            return
        custom_file = self.path_var.get().strip() or self.vault_file
        self.error_var.set("")
        self.on_create(password, custom_file)


# ── Main Vault View ────────────────────────────────────────────────────

class VaultFrame(ttk.Frame):
    def __init__(self, parent, vault: Vault, vault_file: str, on_lock):
        super().__init__(parent)
        self.vault = vault
        self.vault_file = vault_file
        self.on_lock = on_lock

        self.mode = "view"
        self.current_entry_id: Optional[str] = None
        self.password_visible = False
        self.clipboard_timer_id: Optional[str] = None
        self.copied_text: str = ""
        self.lock_timer_id: Optional[str] = None
        self.search_after_id: Optional[str] = None
        self._sash_pos = None

        self.search_var = tk.StringVar()
        self.category_filter_var = tk.StringVar(value="全部")
        self.system_var = tk.StringVar()
        self.url_var = tk.StringVar()
        self.username_var = tk.StringVar()
        self.password_var = tk.StringVar()
        self.category_var = tk.StringVar()
        self.status_var = tk.StringVar(value="就绪")
        self.timer_var = tk.StringVar(value="手动锁定")

        self._build_ui()
        self._refresh_entry_list()

    def _build_ui(self):
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=0)
        self.rowconfigure(1, weight=1)
        self.rowconfigure(2, weight=0)

        # ── Toolbar ──
        toolbar = ttk.Frame(self)
        toolbar.grid(row=0, column=0, sticky="ew", padx=5, pady=(5, 2))

        ttk.Label(toolbar, text="搜索:").pack(side="left")
        ttk.Entry(toolbar, textvariable=self.search_var, width=18,
                  font=("", 10)).pack(side="left", padx=(3, 8))
        self.search_var.trace_add("write", self._on_search_change)

        self.toolbar_sep = ttk.Separator(toolbar, orient="vertical")
        self.toolbar_sep.pack(side="left", fill="y", padx=8)

        ttk.Button(toolbar, text="备份", command=self._do_backup).pack(side="left", padx=1)
        ttk.Button(toolbar, text="还原", command=self._do_restore).pack(side="left", padx=1)

        ttk.Button(toolbar, text="隐藏到托盘", command=self._lock_vault).pack(side="right", padx=4)
        ttk.Button(toolbar, text="自定义热键", command=self._open_settings).pack(side="right", padx=1)
        ttk.Button(toolbar, text="修改主密码", command=self._change_master_password).pack(side="right", padx=1)

        # ── PanedWindow ──
        paned = ttk.PanedWindow(self, orient="horizontal")
        self.paned = paned
        paned.grid(row=1, column=0, sticky="nsew", padx=5, pady=2)

        # Left panel
        left = ttk.Frame(paned)
        paned.add(left, weight=1)

        ttk.Label(left, text="目录:").pack(anchor="w", padx=2, pady=(2, 0))
        self.category_combo = ttk.Combobox(left, textvariable=self.category_filter_var,
                                           state="readonly", font=("", 10))
        self.category_combo.pack(fill="x", padx=2, pady=(0, 4))
        self.category_combo.bind("<<ComboboxSelected>>", lambda e: self._refresh_entry_list())

        tree_frame = ttk.Frame(left)
        tree_frame.pack(fill="both", expand=True)
        tree_frame.rowconfigure(0, weight=1)
        tree_frame.columnconfigure(0, weight=1)

        # ── ExplorerTree widget (XP-style Canvas-based tree) ──
        self.tree = ExplorerTree(
            tree_frame,
            columns=("用户名", "网址"),
            column_widths={0: 150, 1: 60, 2: 150},
            on_select=self._on_tree_select,
            on_double_click=lambda iid: self._open_and_fill(),
            on_right_click=self._on_tree_right_click,
            on_empty_right_click=self._on_tree_empty_right_click,
            on_header_click=self._on_header_click,
        )
        self.tree.grid(row=0, column=0, sticky="nsew")

        # ── Right panel ──
        right = ttk.LabelFrame(paned, text="详情", padding=10)
        self.right_panel = right
        paned.add(right, weight=1)

        right.columnconfigure(1, weight=1)

        labels = [("系统名称:", self.system_var, None),
                  ("目录:", self.category_var, None),
                  ("网址:", self.url_var, None),
                  ("用户名:", self.username_var, "copy_user"),
                  ("密码:", self.password_var, "copy_pwd"),
                  ("备注:", None, "notes")]

        for i, (lbl_text, var, kind) in enumerate(labels):
            r = i
            ttk.Label(right, text=lbl_text, font=("", 10)).grid(
                row=r, column=0, sticky="nw", padx=(0, 5), pady=(3, 2))

            if kind == "copy_user":
                row_f = ttk.Frame(right)
                row_f.grid(row=r, column=1, sticky="ew", pady=(3, 2))
                self.username_entry = ttk.Entry(row_f, textvariable=var, font=("", 10))
                self.username_entry.pack(side="left", fill="x", expand=True)
                ttk.Button(row_f, text="复制", command=self._copy_username).pack(
                    side="left", padx=(2, 0))
            elif kind == "copy_pwd":
                row_f = ttk.Frame(right)
                row_f.grid(row=r, column=1, sticky="ew", pady=(3, 2))
                self.pwd_entry = ttk.Entry(row_f, textvariable=var, font=("", 10), show="*")
                self.pwd_entry.pack(side="left", fill="x", expand=True)
                ttk.Button(row_f, text="显示", command=self._toggle_password_visibility).pack(
                    side="left", padx=(2, 0))
                ttk.Button(row_f, text="复制", command=self._copy_password).pack(
                    side="left", padx=(2, 0))
            elif kind == "notes":
                self.notes_text = tk.Text(right, height=5, font=("", 10), wrap="word")
                self.notes_text.grid(row=r, column=1, sticky="ew", pady=(3, 2))
            elif var is not None:
                entry = ttk.Entry(right, textvariable=var, font=("", 10))
                entry.grid(row=r, column=1, sticky="ew", pady=(3, 2))
                if lbl_text == "系统名称:":
                    self.system_entry = entry
                elif lbl_text == "网址:":
                    self.url_entry = entry
                elif lbl_text == "目录:":
                    self.category_entry = entry

        # Action buttons
        r = len(labels)
        btn_f = ttk.Frame(right)
        btn_f.grid(row=r, column=0, columnspan=2, sticky="ew", pady=(10, 0))
        self.gen_btn = ttk.Button(btn_f, text="生成密码", command=self._open_generator, width=10)
        self.gen_btn.pack(side="left")
        self.primary_btn = ttk.Button(btn_f, text="添加", command=self._save_entry, width=8)
        self.primary_btn.pack(side="right", padx=2)
        self.secondary_btn = ttk.Button(btn_f, text="删除", command=self._delete_entry, width=8)
        self.secondary_btn.pack(side="right", padx=2)

        # ── Help text ──
        help_frame = ttk.LabelFrame(right, text="主要功能说明", padding=8)
        help_frame.grid(row=r + 1, column=0, columnspan=2, sticky="nsew", pady=(8, 0))
        right.rowconfigure(r + 1, weight=1)

        help_text = (
            "备份 — 将密码库文件导出到指定位置\n"
            "还原 — 从备份文件恢复密码库\n"
            "自定义热键 — 修改全局快捷键（默认 Ctrl+Alt）\n"
            "修改主密码 — 更换解锁密码库的主密码\n"
            "\n"
            "双击入口 - 可直接浏览器打开\n"
            "右键目录/入口 - 调出操作菜单"
        )
        bg = ttk.Style().lookup("TLabelFrame", "background")
        self.help_text = tk.Text(help_frame, font=("", 10), fg="gray",
                                 relief="flat", borderwidth=0, bg=bg,
                                 highlightthickness=0, wrap="word",
                                 spacing3=10)
        self.help_text.insert("1.0", help_text)
        self.help_text.configure(state="disabled")
        self.help_text.pack(anchor="nw", fill="both", expand=True)

        # ── Status bar ──
        status = ttk.Frame(self)
        status.grid(row=2, column=0, sticky="ew", padx=5, pady=(2, 5))
        ttk.Label(status, textvariable=self.status_var, font=("", 8)).pack(side="left")
        ttk.Label(status, textvariable=self.timer_var, font=("", 8)).pack(side="right")

        self._enter_view_mode()
        self.bind("<Map>", self._on_first_map)

    def _on_first_map(self, event=None):
        """Align PanedWindow sash with toolbar separator on first display, plus extra width."""
        self.unbind("<Map>")
        self.update_idletasks()
        paned_width = self.paned.winfo_width()
        sash_pos = paned_width // 2
        if sash_pos > 50:
            self.paned.sashpos(0, sash_pos)
            self._sash_pos = sash_pos

    # ── Entry list ────────────────────────────────────────────────────

    @staticmethod
    def _cat_iid(path: str) -> str:
        return f"_cat_{path}"

    @staticmethod
    def _iid_to_path(iid: str) -> str:
        return iid[5:]  # strip "_cat_" prefix

    def _get_all_category_paths(self) -> list[str]:
        """Collect every distinct path prefix from entries and standalone categories."""
        paths = set()
        # From entries
        for entry in self.vault.entries:
            cat = entry.get("category", "") or "无目录"
            parts = [p.strip() for p in cat.split("/") if p.strip()]
            if not parts:
                parts = ["无目录"]
            for i in range(1, len(parts) + 1):
                paths.add("/".join(parts[:i]))
        # From standalone categories
        for cat in self.vault.categories:
            parts = [p.strip() for p in cat.split("/") if p.strip()]
            for i in range(1, len(parts) + 1):
                paths.add("/".join(parts[:i]))
        return sorted(paths)

    def _build_category_tree(self, entries: list[dict]) -> dict:
        """Build nested dict {part: {entries:[], children:{...}}} from path-based categories.
        Also includes standalone (empty) categories from vault.categories."""
        roots: dict[str, dict] = {}

        # First, ensure all standalone categories exist as nodes
        for cat_path in self.vault.categories:
            parts = [p.strip() for p in cat_path.split("/") if p.strip()]
            if not parts:
                continue
            node = roots
            for part in parts:
                node = node.setdefault(part, {"entries": [], "children": {}})
                node = node["children"]

        # Then add entries to their category nodes
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

    def _populate_category_tree(self, tree_data: dict, parent_iid: str,
                                 parent_path: str = ""):
        """Recursively add items using ExplorerTree API."""
        items = sorted(tree_data.items())
        for idx, (name, data) in enumerate(items):
            path = f"{parent_path}/{name}" if parent_path else name
            cat_iid = self._cat_iid(path)

            count = self._count_entries_in_tree(data)
            display_name = f"{name} ({count})" if count else name
            self.tree.add_item(cat_iid, display_name, parent_id=parent_iid,
                               icon="folder", is_leaf=False, is_open=False)

            for entry in data["entries"]:
                self.tree.add_item(entry["id"], entry["system_name"],
                                   parent_id=cat_iid,
                                   values=(entry["username"], entry.get("url", "")),
                                   icon="key", is_leaf=True)

            self._populate_category_tree(data["children"], cat_iid, path)

    @staticmethod
    def _count_entries_in_tree(data: dict) -> int:
        n = len(data.get("entries", []))
        for child in data.get("children", {}).values():
            n += VaultFrame._count_entries_in_tree(child)
        return n

    def _refresh_entry_list(self, query: str = "", expand_path: str = ""):
        # Save currently expanded categories before clearing
        expanded = set()
        for iid, info in self.tree._items.items():
            if iid.startswith("_cat_") and info.is_open:
                expanded.add(self._iid_to_path(iid))
        if expand_path:
            # Also expand all ancestor paths so the target is visible
            parts = expand_path.split("/")
            for i in range(1, len(parts) + 1):
                expanded.add("/".join(parts[:i]))

        self.tree.clear()
        cat_filter = self.category_filter_var.get()

        all_paths = self._get_all_category_paths()
        self.category_combo["values"] = ["全部"] + all_paths

        vault_cat = "" if cat_filter == "全部" else cat_filter
        entries = self.vault.search_entries(query, vault_cat)
        if not entries:
            # If there are standalone categories with no entries (e.g. fresh vault),
            # still build the tree so empty categories are visible.
            if query.strip() or vault_cat or not self.vault.categories:
                self.tree.add_item("_empty_", "（暂无记录）", icon="", is_leaf=True)
                if self.mode != "add":
                    self._enter_view_mode()
                self.tree.redraw()
                return
            # Fall through: build tree from categories only (entries is empty list)

        if query.strip() or vault_cat:
            for entry in entries:
                cat = entry.get("category", "") or "无目录"
                self.tree.add_item(entry["id"], entry["system_name"],
                                   values=(entry["username"],
                                           f"[{cat}] {entry.get('url', '')}"),
                                   icon="key", is_leaf=True)
        else:
            tree_data = self._build_category_tree(entries)
            self._populate_category_tree(tree_data, "")

        # Restore previously expanded categories (must be done BEFORE redraw)
        for path in expanded:
            cat_iid = self._cat_iid(path)
            if cat_iid in self.tree._items:
                self.tree.item(cat_iid, "open", True)

        self.tree.auto_fit_columns()
        self.tree.redraw()

    def _on_header_click(self, col_index: int):
        """Sort siblings within each parent by the clicked column."""
        # Map column index to sort key
        # 0 = tree column (text), 1 = username, 2 = url

        def sort_children(parent_id: str):
            children = self.tree.get_children(parent_id)
            if not children:
                return
            # Build list of (sort_key, item_id)
            items = []
            for cid in children:
                info = self.tree._items.get(cid)
                if info is None:
                    continue
                if col_index == 0:
                    # Sort by text
                    key = info.text.lower()
                elif col_index == 1:
                    key = (info.values[0] if info.values else "").lower()
                else:
                    key = (info.values[1] if len(info.values) > 1 else "").lower()
                items.append((key, cid))
            items.sort(key=lambda x: x[0])
            # Reorder children list
            self.tree._children[parent_id] = [cid for _, cid in items]
            # Recurse into category children
            for _, cid in items:
                if not self.tree._items.get(cid, ItemInfo(cid, "")).is_leaf:
                    sort_children(cid)

        for root_id in self.tree.get_children(""):
            if not self.tree._items.get(root_id, ItemInfo(root_id, "")).is_leaf:
                sort_children(root_id)
        self.tree.redraw()

    def _on_tree_select(self, item_id: str = None):
        if item_id is None:
            return
        if item_id.startswith("_cat_"):
            cat_path = self._iid_to_path(item_id)
            self._enter_add_mode()
            self.category_var.set(cat_path)
            return
        entry = self.vault.get_entry(item_id)
        if entry:
            self._enter_view_entry(entry)

    # ── Context menu ──────────────────────────────────────────────────

    def _on_tree_right_click(self, item_id: str, x_root: int, y_root: int):
        menu = tk.Menu(self, tearoff=0)
        if item_id.startswith("_cat_"):
            self._build_cat_context_menu(menu, item_id)
        else:
            self._build_entry_context_menu(menu, item_id)

        try:
            menu.tk_popup(x_root, y_root)
        finally:
            menu.grab_release()

    def _on_tree_empty_right_click(self, x_root: int, y_root: int):
        """Right-click on empty tree area — show add options."""
        menu = tk.Menu(self, tearoff=0)
        menu.add_command(label="➕ 添加入口", command=self._start_add)
        menu.add_command(label="📁 添加主目录", command=self._add_root_category)
        try:
            menu.tk_popup(x_root, y_root)
        finally:
            menu.grab_release()

    def _build_cat_context_menu(self, menu: tk.Menu, cat_iid: str):
        cat_path = self._iid_to_path(cat_iid)
        menu.add_command(label="➕ 在此添加入口",
                         command=lambda: self._add_entry_to_category(cat_path))
        menu.add_command(label="📁 添加子目录",
                         command=lambda: self._add_subcategory(cat_path))
        menu.add_separator()
        menu.add_command(label="📁 添加主目录",
                         command=self._add_root_category)
        menu.add_command(label="📁 移动到...",
                         command=lambda: self._move_category(cat_path))
        menu.add_separator()
        menu.add_command(label="📝 重命名目录",
                         command=lambda: self._rename_category(cat_path))
        menu.add_command(label="🗑 删除目录",
                         command=lambda: self._delete_category(cat_path))

    def _build_entry_context_menu(self, menu: tk.Menu, entry_id: str):
        menu.add_command(label="📝 编辑", command=self._start_edit)
        menu.add_command(label="📋 复制密码", command=self._copy_password)
        menu.add_command(label="📋 复制用户名", command=self._copy_username)
        menu.add_separator()
        menu.add_command(label="📁 移动到...",
                         command=lambda: self._move_entry(entry_id))
        menu.add_separator()
        menu.add_command(label="🗑 删除入口", command=self._delete_entry)

    # ── Context menu actions ──────────────────────────────────────────

    def _add_entry_to_category(self, cat_path: str):
        """Open add mode with category pre-filled."""
        self._enter_add_mode()
        self.category_var.set(cat_path)

    def _add_subcategory(self, parent_path: str):
        """Ask for sub-category name and register it directly in the vault."""
        name = simpledialog.askstring("添加子目录",
            f"在「{parent_path}」下创建子目录:\n\n请输入名称:",
            parent=self)
        if not name or not name.strip():
            return
        name = name.strip().replace("/", "-")  # prevent nested paths in name
        new_path = f"{parent_path}/{name}"
        self.vault.add_category(new_path)
        self.vault.save(self.vault_file)
        self._refresh_entry_list(self.search_var.get())
        self.status_var.set(f"子目录「{new_path}」已创建")

    def _add_root_category(self):
        """Ask for a top-level category name."""
        name = simpledialog.askstring("添加主目录",
            "请输入主目录名称:",
            parent=self)
        if not name or not name.strip():
            return
        name = name.strip().replace("/", "-")
        self.vault.add_category(name)
        self.vault.save(self.vault_file)
        self._refresh_entry_list(self.search_var.get())
        self.status_var.set(f"主目录「{name}」已创建")

    def _delete_category(self, cat_path: str):
        """Delete category and all entries under it."""
        matching = [e for e in self.vault.entries
                    if (e.get("category", "") or "无目录").startswith(cat_path)]
        count = len(matching)
        if not count:
            # Check if there are empty sub-categories
            prefix = cat_path + "/"
            child_cats = [c for c in self.vault.categories if c.startswith(prefix)]
            if not child_cats and cat_path not in self.vault.categories:
                messagebox.showinfo("提示", "该目录下没有入口")
                return
            count = len(child_cats) + (1 if cat_path in self.vault.categories else 0)

        confirm = messagebox.askyesno("确认删除",
            f"将删除「{cat_path}」及其子目录下的 {count} 条记录。\n\n此操作不可撤销，确定继续？")
        if not confirm:
            return
        self.vault.delete_category(cat_path)
        self.vault.save(self.vault_file)
        self._enter_view_mode()
        self._refresh_entry_list(self.search_var.get())
        self.status_var.set(f"已删除目录: {cat_path}")

    def _rename_category(self, old_path: str):
        """Rename a category by updating vault categories and all matching entries."""
        new_name = simpledialog.askstring("重命名目录",
            f"将「{old_path}」重命名为:\n\n请输入新名称:",
            parent=self, initialvalue=old_path.split("/")[-1] if "/" in old_path else old_path)
        if not new_name or not new_name.strip():
            return
        new_name = new_name.strip().replace("/", "-")
        # Build new path: replace last segment
        if "/" in old_path:
            new_path = "/".join(old_path.split("/")[:-1]) + "/" + new_name
        else:
            new_path = new_name

        self.vault.rename_category(old_path, new_path)
        self.vault.save(self.vault_file)
        self._refresh_entry_list(self.search_var.get())
        self.status_var.set(f"已重命名: {old_path} → {new_path}")

    def _move_entry(self, entry_id: str):
        """Show category picker and move entry to chosen category."""
        entry = self.vault.get_entry(entry_id)
        if not entry:
            return
        paths = self._get_all_category_paths()
        paths = ["（无目录）"] + [p for p in paths if p != "无目录"]

        dialog = CategoryPickerDialog(self, paths, entry.get("category", ""))
        self.wait_window(dialog)
        if dialog.result is not None:
            entry["category"] = dialog.result
            self.vault.dirty = True
            self.vault.save(self.vault_file)
            self._refresh_entry_list(self.search_var.get())
            self.status_var.set(f"已移动: {entry['system_name']}")

    def _move_category(self, cat_path: str):
        """Show category picker and move category (and all entries) to chosen destination."""
        paths = self._get_all_category_paths()
        # Remove self and children from options
        prefix = cat_path + "/"
        paths = [p for p in paths if p != cat_path and not p.startswith(prefix)]
        paths = sorted(paths)
        # Add "(主目录)" option at top
        options = ["（主目录）"] + paths

        dialog = CategoryPickerDialog(self, options, "", item_label="目录")
        dialog.title("移动目录")
        self.wait_window(dialog)
        if dialog.result is None:
            return

        dest = dialog.result
        leaf = cat_path.rsplit("/", 1)[-1]
        if dest == "（主目录）":
            new_path = leaf
        else:
            new_path = dest + "/" + leaf

        if new_path == cat_path:
            return

        self.vault.rename_category(cat_path, new_path)
        self.vault.save(self.vault_file)
        self._refresh_entry_list(self.search_var.get())
        self.status_var.set(f"已移动目录: {cat_path} → {new_path}")

    def _on_search_change(self, *_):
        if self.search_after_id is not None:
            self.after_cancel(self.search_after_id)
        self.search_after_id = self.after(SEARCH_DEBOUNCE, self._do_search)

    def _do_search(self):
        self._refresh_entry_list(self.search_var.get())

    # ── Mode switching ───────────────────────────────────────────────

    def _set_fields_state(self, readonly: bool):
        """Set all detail fields to readonly or normal."""
        state = "readonly" if readonly else "normal"
        for w in [self.system_entry, self.category_entry, self.url_entry,
                  self.username_entry, self.pwd_entry]:
            w.configure(state=state)
        if readonly:
            self.notes_text.configure(state="disabled")
        else:
            self.notes_text.configure(state="normal")

    def _show_right_panel(self):
        try:
            self.paned.add(self.right_panel, weight=3)
        except tk.TclError:
            pass  # already added
        if self._sash_pos is not None:
            self.paned.sashpos(0, self._sash_pos)

    def _hide_right_panel(self):
        try:
            self.paned.forget(self.right_panel)
        except tk.TclError:
            pass

    def _enter_view_mode(self):
        """Idle state — no entry selected, form cleared, right panel visible."""
        self.mode = "view"
        self.current_entry_id = None
        self._clear_form()
        self._show_right_panel()
        if len(self.vault.entries) == 0:
            self.status_var.set("欢迎使用，请右键树形区域添加入口或目录")
        else:
            self.status_var.set("就绪 — 从左侧列表选择记录查看详情")

    def _clear_form(self):
        self.system_var.set("")
        self.url_var.set("")
        self.username_var.set("")
        self.password_var.set("")
        self.category_var.set("")
        self.notes_text.delete("1.0", "end")
        self.password_visible = False
        self.pwd_entry.config(show="*")
        self._set_fields_state(False)

    def _enter_add_mode(self):
        """Adding a new entry — fields editable, button [添加]."""
        self.mode = "add"
        self.current_entry_id = None
        self._clear_form()
        self._set_fields_state(False)
        self._show_right_panel()
        self.primary_btn.config(text="添加", command=self._save_entry)
        self.secondary_btn.pack_forget()
        self.status_var.set("填写信息后点击 [添加]")

    def _enter_view_entry(self, entry: dict):
        """View an entry — fields readonly, buttons [编辑] [删除]."""
        self.mode = "view_entry"
        self.current_entry_id = entry["id"]
        self.system_var.set(entry["system_name"])
        self.url_var.set(entry["url"])
        self.username_var.set(entry["username"])
        self.password_var.set(entry["password"])
        self.category_var.set(entry.get("category", ""))
        self.password_visible = False
        self.pwd_entry.config(show="*")
        self.notes_text.configure(state="normal")
        self.notes_text.delete("1.0", "end")
        self.notes_text.insert("1.0", entry.get("notes", ""))
        self._set_fields_state(True)
        self._show_right_panel()
        self.primary_btn.config(text="编辑", command=self._start_edit)
        self.secondary_btn.config(text="删除", command=self._delete_entry)
        self.secondary_btn.pack(side="right", padx=2)
        self.status_var.set(f"查看: {entry['system_name']}")

    def _start_edit(self):
        """Switch from view_entry to edit mode."""
        self.mode = "edit"
        self._set_fields_state(False)
        self.primary_btn.config(text="更新", command=self._do_update)
        self.secondary_btn.config(text="取消", command=self._cancel_edit)
        self.status_var.set("编辑模式")

    def _cancel_edit(self):
        """Cancel editing — reload entry and go back to view_entry."""
        entry = self.vault.get_entry(self.current_entry_id)
        if entry:
            self._enter_view_entry(entry)
        else:
            self._enter_view_mode()

    def _do_update(self):
        """Save edited entry and return to view_entry."""
        self._save_entry()
        if self.mode == "edit":
            entry = self.vault.get_entry(self.current_entry_id)
            if entry:
                self._enter_view_entry(entry)

    def _start_add(self):
        self._enter_add_mode()

    def _save_entry(self):
        system_name = self.system_var.get().strip()
        password = self.password_var.get()
        if not system_name:
            messagebox.showwarning("缺少信息", "系统名称不能为空")
            return
        if not password:
            messagebox.showwarning("缺少信息", "密码不能为空")
            return

        url = self.url_var.get().strip()
        username = self.username_var.get().strip()
        notes = self.notes_text.get("1.0", "end").strip()
        category = self.category_var.get().strip()

        if self.mode == "edit" and self.current_entry_id:
            self.vault.update_entry(self.current_entry_id, system_name=system_name,
                                    url=url, username=username, password=password,
                                    notes=notes, category=category)
            self.status_var.set(f"已更新: {system_name}")
        else:
            eid = self.vault.add_entry(system_name, url, username, password, notes, category)
            self.current_entry_id = eid
            self.status_var.set(f"已添加: {system_name}")

        self.vault.save(self.vault_file)
        if self.mode == "add" and category:
            self._refresh_entry_list(self.search_var.get(), expand_path=category)
        else:
            self._refresh_entry_list(self.search_var.get())

        if self.mode == "add":
            entry = self.vault.get_entry(self.current_entry_id)
            if entry:
                self._enter_view_entry(entry)
                self.status_var.set(f"添加成功: {entry['system_name']}")

    def _delete_entry(self):
        if not self.current_entry_id:
            messagebox.showinfo("未选择", "请先选择一个要删除的记录")
            return
        entry = self.vault.get_entry(self.current_entry_id)
        if not entry:
            return
        confirm = messagebox.askyesno("确认删除",
            f"确定要删除 \"{entry['system_name']}\" 吗？\n此操作不可撤销。")
        if not confirm:
            return
        name = entry["system_name"]
        self.vault.delete_entry(self.current_entry_id)
        self.vault.save(self.vault_file)
        self._enter_view_mode()
        self._refresh_entry_list(self.search_var.get())
        self.status_var.set(f"已删除: {name}")

    # ── Clipboard ────────────────────────────────────────────────────

    def _copy_to_clipboard(self, text: str, label: str):
        self.clipboard_clear()
        self.clipboard_append(text)
        self.copied_text = text
        if self.clipboard_timer_id is not None:
            self.after_cancel(self.clipboard_timer_id)
        self.clipboard_timer_id = self.after(CLIPBOARD_CLEAR_DELAY, self._clear_clipboard)
        self.status_var.set(f"{label}已复制（30秒后清除）")

    def _clear_clipboard(self):
        try:
            if self.clipboard_get() == self.copied_text:
                self.clipboard_clear()
                self.status_var.set("剪贴板已清除")
        except tk.TclError:
            pass
        self.clipboard_timer_id = None
        self.copied_text = ""

    def _copy_username(self):
        u = self.username_var.get()
        if u:
            self._copy_to_clipboard(u, "用户名")

    def _copy_password(self):
        p = self.password_var.get()
        if p:
            self._copy_to_clipboard(p, "密码")

    def _open_and_fill(self):
        """双击入口: 用默认浏览器打开网址, 并自动填充用户名和密码。"""
        if not self.current_entry_id:
            return
        entry = self.vault.get_entry(self.current_entry_id)
        if not entry:
            return
        url = (entry.get("url") or "").strip()
        if not url:
            messagebox.showwarning("提示", "该入口没有网址")
            return

        # 补全协议头
        if not url.startswith(("http://", "https://")):
            url = "https://" + url

        username = entry["username"]
        password = entry["password"]

        webbrowser.open(url)
        self.status_var.set(f"已打开 {entry['system_name']}，10秒内持续检测并填充凭证...")

        if _PYNPUT_AVAILABLE:
            def _do_fill():
                initial_wait = 2.0
                retry_interval = 5.0
                max_duration = 12.0
                started = time.time()
                time.sleep(initial_wait)

                kc = _PynputController()
                attempt = 0
                while True:
                    elapsed = time.time() - started
                    if elapsed > max_duration:
                        break
                    attempt += 1
                    try:
                        _paste_and_fill(kc, username, password)
                    except Exception:
                        pass
                    time.sleep(retry_interval)

            threading.Thread(target=_do_fill, daemon=True).start()
        else:
            # 无 pynput 时，至少复制密码到剪贴板
            self.clipboard_clear()
            self.clipboard_append(password)
            self.status_var.set(f"已打开 {entry['system_name']}，密码已复制到剪贴板")

    def _toggle_password_visibility(self):
        self.password_visible = not self.password_visible
        self.pwd_entry.config(show="" if self.password_visible else "*")

    def _open_generator(self):
        dialog = PasswordGeneratorDialog(self)
        self.wait_window(dialog)
        if dialog.result:
            self.password_var.set(dialog.result)
            self.password_visible = True
            if self.mode == "view_entry":
                self._start_edit()
            self.pwd_entry.config(show="")
            self.status_var.set("已生成新密码")

    # ── Backup / Restore ─────────────────────────────────────────────

    def _do_backup(self):
        if not os.path.exists(self.vault_file):
            messagebox.showwarning("备份失败", "密码库文件不存在")
            return
        dest = filedialog.asksaveasfilename(
            title="选择备份位置", defaultextension=".enc",
            filetypes=[("密码库文件", "*.enc"), ("所有文件", "*.*")],
            initialfile="vault_backup.enc")
        if not dest:
            return
        try:
            shutil.copy2(self.vault_file, dest)
            messagebox.showinfo("备份成功", f"密码库已备份到:\n{dest}")
            self.status_var.set("备份完成")
        except Exception as e:
            messagebox.showerror("备份失败", str(e))

    def _do_restore(self):
        if not messagebox.askyesno("确认还原",
            "还原将替换当前所有密码数据，且需要重启程序。\n\n确定要继续吗？"):
            return
        src = filedialog.askopenfilename(
            title="选择备份文件",
            filetypes=[("密码库文件", "*.enc"), ("所有文件", "*.*")])
        if not src:
            return
        try:
            shutil.copy2(src, self.vault_file)
            messagebox.showinfo("还原成功", "密码库已还原，程序将自动锁定。\n请重新解锁。")
            self._lock_vault()
        except Exception as e:
            messagebox.showerror("还原失败", str(e))

    def _change_master_password(self):
        """Change the vault master password."""
        from crypto_utils import derive_key
        # Verify current password first
        from tkinter import simpledialog
        old_pwd = simpledialog.askstring("验证当前密码", "请输入当前主密码:",
                                         parent=self, show="*")
        if not old_pwd:
            return
        try:
            # Verify by checking if the derived key matches
            derived = derive_key(old_pwd, self.vault.salt)
            if derived != self.vault.key:
                messagebox.showerror("错误", "当前密码不正确")
                return
        except Exception:
            messagebox.showerror("错误", "验证失败")
            return

        new_pwd = simpledialog.askstring("新密码", "请输入新主密码 (至少8位):",
                                          parent=self, show="*")
        if not new_pwd:
            return
        if len(new_pwd) < MIN_PASSWORD_LENGTH:
            messagebox.showwarning("密码太短", f"主密码至少需要 {MIN_PASSWORD_LENGTH} 个字符")
            return
        confirm = simpledialog.askstring("确认新密码", "请再次输入新主密码:",
                                          parent=self, show="*")
        if new_pwd != confirm:
            messagebox.showerror("错误", "两次输入的密码不一致")
            return

        self.vault.change_password(new_pwd)
        self.vault.save(self.vault_file)
        self.status_var.set("主密码已修改成功")

    def _open_settings(self):
        from quick_access import HotkeySettingsDialog
        config = qa_load_config()
        HotkeySettingsDialog(self, config, self._on_config_changed)

    def _on_config_changed(self, config: dict):
        parent = self.winfo_toplevel()
        app = getattr(parent, "_app", None)
        if app:
            app.config = config
            app.hotkey.config = config
            app.hotkey.restart()

    # ── Lock / Hide ────────────────────────────────────────────────────

    def _lock_vault(self):
        """Hide to system tray — vault stays unlocked for quick access."""
        if self.vault.dirty:
            try:
                self.vault.save(self.vault_file)
            except Exception as e:
                messagebox.showerror("保存失败", f"保存失败:\n{e}")
                return
        if self.lock_timer_id is not None:
            self.after_cancel(self.lock_timer_id)
        if self.clipboard_timer_id is not None:
            self.after_cancel(self.clipboard_timer_id)
        try:
            self.clipboard_clear()
        except tk.TclError:
            pass
        self.winfo_toplevel().withdraw()

    def cleanup(self):
        for tid in [self.lock_timer_id,
                     self.clipboard_timer_id, self.search_after_id]:
            if tid:
                self.after_cancel(tid)


# ── Main App ───────────────────────────────────────────────────────────

class PasswordManagerApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("密码管理器")
        self.root.geometry("860x580")
        self.root.minsize(700, 420)
        self.root._app = self

        # Set app icon
        icon_path = _get_icon_path()
        if icon_path:
            try:
                self.root.iconbitmap(icon_path)
            except tk.TclError:
                pass

        self.vault: Optional[Vault] = None
        self.vault_file = VAULT_FILE
        self.config = qa_load_config()
        self.hotkey = HotkeyManager(self._show_quick_access, self.config)

        self.container = ttk.Frame(root)
        self.container.pack(fill="both", expand=True)

        self.login_frame = LoginFrame(
            self.container, on_unlock=self._handle_unlock,
            on_create=self._handle_create, vault_file=self.vault_file,
            config=self.config)
        self.vault_frame: Optional[VaultFrame] = None

        vault_exists = os.path.exists(self.vault_file)
        self.login_frame.grid(row=0, column=0, sticky="nsew")
        self.container.rowconfigure(0, weight=1)
        self.container.columnconfigure(0, weight=1)
        self.login_frame.set_state(vault_exists)

    def _handle_unlock(self, password: str):
        try:
            self.vault = Vault.load(self.vault_file, password)
        except FileNotFoundError:
            self.login_frame.error_var.set("密码库文件不存在，请先创建")
            return
        except Exception:
            locked, lock_mins = record_failed_attempt()
            if locked:
                self.login_frame.error_var.set(f"连续5次错误，已锁定 {lock_mins} 分钟")
                self.login_frame._check_lockout()
            else:
                state = load_lockout()
                remaining = 5 - state.get("failed_attempts", 0)
                self.login_frame.error_var.set(f"主密码错误，还剩 {remaining} 次尝试")
                self.login_frame.password_var.set("")
            return

        record_successful_unlock()
        self._enter_vault()

    def _handle_create(self, password: str, custom_file: str = ""):
        target_file = custom_file or self.vault_file
        os.makedirs(os.path.dirname(target_file), exist_ok=True)
        try:
            self.vault = Vault.create(target_file, password)
        except PermissionError:
            self.login_frame.error_var.set("无法创建密码库，请检查目录权限")
            return
        except Exception as e:
            self.login_frame.error_var.set(f"创建失败: {e}")
            return

        self.vault_file = target_file
        if custom_file and custom_file != VAULT_FILE:
            self.config["vault_path"] = custom_file
            qa_save_config(self.config)

        self._enter_vault()

    def _enter_vault(self):
        self.login_frame.grid_forget()
        if self.vault_frame is not None:
            self.vault_frame.cleanup()
        self.vault_frame = VaultFrame(
            self.container, vault=self.vault, vault_file=self.vault_file,
            on_lock=self._handle_lock)
        self.vault_frame.grid(row=0, column=0, sticky="nsew")
        self.vault_frame.focus_set()
        self.hotkey.start()

    def _handle_lock(self):
        self.hotkey.stop()
        if self.vault_frame:
            self.vault_frame.cleanup()
            self.vault_frame = None
        self.vault = None
        self.login_frame.grid(row=0, column=0, sticky="nsew")
        vault_exists = os.path.exists(self.vault_file)
        self.login_frame.set_state(vault_exists,
            "密码库已锁定，请输入主密码" if vault_exists else "")

    def _show_quick_access(self):
        if self.vault and not self.vault.is_locked:
            self.root.after(0, self._show_quick_access_popup)
        elif os.path.exists(self.vault_file):
            self.root.after(0, self._show_quick_unlock)

    def _show_quick_unlock(self):
        """Prompt for master password, unlock temporarily, show quick access, re-lock."""
        pwd = simpledialog.askstring("密码管理器", "请输入主密码:", show="*")
        if not pwd:
            return
        try:
            temp_vault = Vault.load(self.vault_file, pwd)
        except Exception:
            messagebox.showerror("错误", "主密码错误")
            return
        popup = QuickAccessPopup(self.root, temp_vault, self.config,
                                 on_config_save=self._on_config_saved)
        self.root.wait_window(popup)
        temp_vault.lock()

    def _show_quick_access_popup(self):
        if not self.vault or self.vault.is_locked:
            return
        popup = QuickAccessPopup(self.root, self.vault, self.config,
                                 on_config_save=self._on_config_saved)
        self.root.wait_window(popup)

    def _on_config_saved(self, config: dict):
        self.config = config
        self.hotkey.config = config
        self.hotkey.restart()

    def _on_close(self):
        self.hotkey.stop()
        if self.vault and not self.vault.is_locked and self.vault.dirty:
            try:
                self.vault.save(self.vault_file)
            except Exception as e:
                messagebox.showerror("保存失败", f"关闭前保存失败:\n{e}")
        if self.vault_frame:
            self.vault_frame.cleanup()
        self.root.destroy()
