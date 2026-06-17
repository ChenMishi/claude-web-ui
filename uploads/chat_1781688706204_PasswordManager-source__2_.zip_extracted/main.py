#!/usr/bin/env python3
"""Password Manager — Encrypted Password Vault with System Tray"""

import os
import sys
import tkinter as tk
import threading
from PIL import Image, ImageDraw, ImageTk


def create_tray_icon():
    """Generate a simple lock icon for the system tray."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Lock body
    draw.rectangle([16, 28, 48, 52], fill="#4F46E5")
    # Lock shackle
    draw.arc([22, 10, 42, 38], start=180, end=0, fill="#4F46E5", width=6)
    # Keyhole
    draw.ellipse([28, 35, 36, 43], fill="white")
    draw.rectangle([30, 40, 34, 46], fill="white")
    return img


def _get_icon_path():
    """Return path to icon.ico, handling PyInstaller bundled paths."""
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


class TrayManager:
    """Manages system tray icon and window hide/show behavior."""

    def __init__(self, root: tk.Tk, app):
        self.root = root
        self.app = app
        self._tray = None
        self._setup_tray()

    def _setup_tray(self):
        try:
            import pystray
        except ImportError:
            return

        icon_path = _get_icon_path()
        icon = None
        if icon_path:
            try:
                icon = Image.open(icon_path)
            except Exception:
                icon = None
        if icon is None:
            icon = create_tray_icon()
        menu = pystray.Menu(
            pystray.MenuItem("显示", self._restore_window, default=True),
            pystray.MenuItem("退出", self._quit_app),
        )
        self._tray = pystray.Icon("PasswordManager", icon, "密码管理器", menu)

    def start(self):
        if self._tray is None:
            return
        # Run tray in background thread
        t = threading.Thread(target=self._tray.run, daemon=True)
        t.start()

    def hide_to_tray(self):
        self.root.withdraw()

    def _restore_window(self, icon=None, item=None):
        self.root.after(0, self._do_restore)

    def _do_restore(self):
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def _quit_app(self, icon=None, item=None):
        if self._tray:
            self._tray.stop()
        self.root.after(0, self._do_quit)

    def _do_quit(self):
        self.app._on_close()
        self.root.destroy()

    def stop(self):
        if self._tray:
            self._tray.stop()


def _show_close_dialog(root, tray, app):
    """Show a dialog asking the user to quit or minimize to tray."""
    dialog = tk.Toplevel(root)
    dialog.title("密码管理器")
    dialog.resizable(False, False)
    dialog.transient(root)
    dialog.grab_set()
    _set_window_icon(dialog)

    f = tk.Frame(dialog, padx=20, pady=15)
    f.pack()

    tk.Label(f, text="请选择操作", font=("", 11, "bold")).pack(pady=(0, 12))

    btn_frame = tk.Frame(f)
    btn_frame.pack()

    result = {"value": None}

    def do_tray():
        result["value"] = "tray"
        dialog.destroy()

    def do_quit():
        result["value"] = "quit"
        dialog.destroy()

    def do_cancel():
        result["value"] = "cancel"
        dialog.destroy()

    tk.Button(btn_frame, text="最小化到托盘", command=do_tray,
              width=14, height=2).pack(side="left", padx=4)
    tk.Button(btn_frame, text="退出程序", command=do_quit,
              width=14, height=2).pack(side="left", padx=4)
    tk.Button(btn_frame, text="取消", command=do_cancel,
              width=14, height=2).pack(side="left", padx=4)

    # Center on parent
    dialog.update_idletasks()
    pw = root.winfo_width()
    ph = root.winfo_height()
    px = root.winfo_rootx()
    py = root.winfo_rooty()
    dw = dialog.winfo_width()
    dh = dialog.winfo_height()
    dialog.geometry(f"+{px + (pw - dw) // 2}+{py + (ph - dh) // 2}")

    dialog.wait_window()

    if result["value"] == "tray":
        tray.hide_to_tray()
    elif result["value"] == "quit":
        app._on_close()
        root.destroy()


def main():
    try:
        import cryptography  # noqa: F401
    except ImportError:
        print("Error: 'cryptography' package is not installed.", file=sys.stderr)
        print("Install it with: pip install cryptography", file=sys.stderr)
        sys.exit(1)

    from gui import PasswordManagerApp, ensure_vault_dir

    ensure_vault_dir()

    from quick_access import load_config
    config = load_config()
    vault_file = config.get("vault_path", "")
    if vault_file and os.path.exists(vault_file):
        import gui
        gui.VAULT_FILE = vault_file

    root = tk.Tk()
    _set_window_icon(root)
    app = PasswordManagerApp(root)

    # System tray
    tray = TrayManager(root, app)

    # Override close button → ask user
    def on_close():
        _show_close_dialog(root, tray, app)

    root.protocol("WM_DELETE_WINDOW", on_close)

    # Override minimize → hide to tray
    def on_minimize(event=None):
        if root.state() == "iconic":
            tray.hide_to_tray()

    root.bind("<Unmap>", on_minimize)

    tray.start()
    root.mainloop()


if __name__ == "__main__":
    main()
