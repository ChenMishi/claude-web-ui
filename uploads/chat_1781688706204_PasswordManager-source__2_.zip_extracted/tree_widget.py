#!/usr/bin/env python3
"""ExplorerTree — Canvas-based tree widget with Windows XP Explorer styling.

Dotted guide lines, gray +/- toggle boxes, retro folder/key icons,
deep blue selection highlight, column headers, and keyboard navigation.
"""

import tkinter as tk
from tkinter import font as tkfont
from typing import Optional, Callable
from dataclasses import dataclass, field

from PIL import Image, ImageDraw, ImageTk


# ── Item data ────────────────────────────────────────────────────

@dataclass
class ItemInfo:
    item_id: str
    text: str
    values: tuple = ()
    icon: str = ""           # "folder", "key", "clock", or ""
    is_leaf: bool = True     # True for entries, False for folders
    is_open: bool = False    # expand/collapse state (folders only)
    parent_id: str = ""      # "" = root level
    depth: int = 0
    is_last_sibling: bool = False
    _y_offset: int = 0       # assigned during layout


# ── Main widget ──────────────────────────────────────────────────

class ExplorerTree(tk.Frame):
    """A folder-tree widget replicating Windows XP Explorer appearance.

    Key visual features:
      - Dotted gray vertical/horizontal guide lines
      - 9×9 gray +/- toggle boxes for folder items
      - Retro yellow 3D folder icon, blue-green spherical key icon
      - Full-row deep-blue (#0078D7) selection with white text
      - Optional column headers with click-to-sort
      - Alternating row stripes for entry items
    """

    ROW_HEIGHT = 22
    INDENT = 20           # pixels per depth level
    TOGGLE_SIZE = 9       # side length of +/- box
    TOGGLE_MARGIN = 2     # left margin inside indent slot
    ICON_GAP = 3          # gap between toggle right edge and icon
    LINE_COLOR = "#C0C0C0"
    LINE_DASH = (1, 3)    # dotted
    SELECT_BG = "#0078D7"
    SELECT_FG = "white"
    STRIPE_BG = "#f0f4f8"
    HEADER_BG = "#F0F0F0"
    SEP_COLOR = "#E0E0E0"
    FONT_FAMILY = "Segoe UI"
    FONT_SIZE = 9

    # ── Layout helpers ────────────────────────────────────────────

    def _toggle_x(self, depth: int) -> int:
        """Left edge of toggle box at given depth."""
        return depth * self.INDENT + self.TOGGLE_MARGIN

    def _vline_x(self, depth: int) -> int:
        """X position of vertical guide line (center of toggle box)."""
        return depth * self.INDENT + self.TOGGLE_MARGIN + self.TOGGLE_SIZE // 2

    def _icon_x(self, depth: int) -> int:
        """Left edge of icon at given depth (same for leaves and folders)."""
        return depth * self.INDENT + self.TOGGLE_MARGIN + self.TOGGLE_SIZE + self.ICON_GAP

    def _text_x(self, depth: int) -> int:
        """Left edge of tree column text."""
        return self._icon_x(depth) + 20 + 3  # icon width + margin

    def __init__(self, parent, *,
                 columns: tuple = (),
                 column_widths: dict = None,
                 on_select: Callable[[str], None] = None,
                 on_toggle: Callable[[str, bool], None] = None,
                 on_double_click: Callable[[str], None] = None,
                 on_right_click: Callable[[str, int, int], None] = None,
                 on_empty_right_click: Callable[[int, int], None] = None,
                 on_header_click: Callable[[int], None] = None,
                 **kwargs):
        super().__init__(parent, **kwargs)

        self._columns = columns
        self._col_widths = column_widths or {}
        self._on_select = on_select
        self._on_toggle = on_toggle
        self._on_double_click = on_double_click
        self._on_right_click = on_right_click
        self._on_empty_right_click = on_empty_right_click
        self._on_header_click = on_header_click

        # Internal state
        self._items: dict[str, ItemInfo] = {}
        self._children: dict[str, list[str]] = {"": []}
        self._visible_order: list[str] = []
        self._selected_id: Optional[str] = None
        self._total_height = 0
        self._header_height = 0  # headers are now on separate fixed canvas

        # Canvas objects per item: {item_id: [canvas_ids, ...]}
        self._canvas_objs: dict[str, list[int]] = {}

        # Font
        self._font = self._get_font()

        # Instance-level icon cache (created lazily, needs tk root)
        self._icon_cache: dict[str, ImageTk.PhotoImage] = {}

        # ── Build UI ──
        # Header canvas (fixed, non-scrolling)
        self._header_canvas = tk.Canvas(
            self, bg=self.HEADER_BG, highlightthickness=0, height=self.ROW_HEIGHT)
        self._header_canvas.pack(side="top", fill="x")

        # Data area: canvas + scrollbar
        data_frame = tk.Frame(self)
        data_frame.pack(side="top", fill="both", expand=True)

        self._scrollbar = tk.Scrollbar(data_frame, orient="vertical")
        self._canvas = tk.Canvas(
            data_frame, bg="white", highlightthickness=0,
            yscrollcommand=self._scrollbar.set, takefocus=True,
        )
        self._scrollbar.config(command=self._canvas.yview)
        self._canvas.pack(side="left", fill="both", expand=True)
        self._scrollbar.pack(side="right", fill="y")
        self._scrollbar.pack_forget()  # hide initially, show only when content overflows

        # Icons — create after tk root is available
        self._ensure_icons()

        # Mouse bindings on data canvas
        self._canvas.bind("<Button-1>", self._on_click)
        self._canvas.bind("<Double-1>", self._on_double)
        self._canvas.bind("<Button-2>", self._on_right)
        self._canvas.bind("<Button-3>", self._on_right)
        self._canvas.bind("<Shift-F10>", self._on_context_menu)
        self._canvas.bind("<Menu>", self._on_context_menu)

        # Scroll (only when scrollbar is visible = content overflows)
        self._canvas.bind("<MouseWheel>", self._on_mousewheel)
        self._canvas.bind("<Button-4>", lambda e: self._canvas.yview_scroll(-1, "units")
                          if self._scrollbar.winfo_ismapped() else None)
        self._canvas.bind("<Button-5>", lambda e: self._canvas.yview_scroll(1, "units")
                          if self._scrollbar.winfo_ismapped() else None)

        # Keyboard
        self._canvas.bind("<Up>", self._on_key_up)
        self._canvas.bind("<Down>", self._on_key_down)
        self._canvas.bind("<Return>", self._on_key_enter)
        self._canvas.bind("<Left>", self._on_key_left)
        self._canvas.bind("<Right>", self._on_key_right_)

        # Resize — sync header width with data canvas width
        self._canvas.bind("<Configure>", self._on_resize)

        # Header click bindings (click to sort, drag to resize columns)
        self._header_canvas.bind("<Button-1>", self._on_header_press)
        self._header_canvas.bind("<B1-Motion>", self._on_header_drag)
        self._header_canvas.bind("<ButtonRelease-1>", self._on_header_release)

        self._header_rects: list[tuple[int, int, int, int]] = []
        self._separator_xs: list[int] = []  # x positions of column separators for drag-resize

        # Column drag-resize state
        self._drag_col: Optional[int] = None  # column index being resized
        self._drag_start_x: int = 0
        self._drag_start_width: int = 0
        self._drag_min_width: int = 40  # minimum column width in pixels

    # ── Icon factory ──────────────────────────────────────────────

    def _ensure_icons(self):
        if self._icon_cache:
            return
        self._icon_cache["folder"] = self._make_folder_icon()
        self._icon_cache["key"] = self._make_key_icon()
        self._icon_cache["clock"] = self._make_clock_icon()

    def _make_folder_icon(self) -> ImageTk.PhotoImage:
        img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        # Tab
        d.polygon([(2, 5), (8, 5), (10, 8), (2, 8)], fill="#FFD54F")
        # Main body
        d.rectangle([2, 7, 18, 18], fill="#FFC107")
        # Top highlight edge
        d.line([(2, 7), (18, 7)], fill="#FFE082", width=1)
        # Right shadow
        d.line([(18, 7), (18, 18)], fill="#E5A100", width=1)
        # Bottom shadow
        d.line([(2, 18), (18, 18)], fill="#E5A100", width=1)
        # Front face lighter
        d.rectangle([3, 8, 17, 17], fill="#FFCA28")
        # Inner highlight
        d.line([(4, 8), (16, 8)], fill="#FFE082", width=1)
        return ImageTk.PhotoImage(img)

    def _make_key_icon(self) -> ImageTk.PhotoImage:
        img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        # Key head (circle with border)
        d.ellipse([4, 1, 15, 12], fill="#0891B2", outline="#067589", width=1)
        # Key hole
        d.ellipse([8, 4, 11, 7], fill="#CCFBF1")
        # Shaft
        d.rectangle([8, 9, 11, 18], fill="#0891B2")
        # Teeth
        d.rectangle([4, 9, 8, 11], fill="#0891B2")
        d.rectangle([4, 13, 8, 15], fill="#0891B2")
        d.rectangle([4, 15, 7, 17], fill="#0891B2")
        # Highlight
        d.ellipse([5, 2, 9, 5], fill="#22D3EE")
        return ImageTk.PhotoImage(img)

    def _make_clock_icon(self) -> ImageTk.PhotoImage:
        img = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse([2, 2, 18, 18], fill="white", outline="#3B82F6", width=2)
        d.line([10, 10, 10, 5], fill="#3B82F6", width=2)
        d.line([10, 10, 14, 12], fill="#3B82F6", width=2)
        d.ellipse([8, 8, 12, 12], fill="#3B82F6")
        return ImageTk.PhotoImage(img)

    # ── Font helper ──────────────────────────────────────────────

    def _get_font(self):
        families = [self.FONT_FAMILY, "TkDefaultFont", "Helvetica", "Arial"]
        for fam in families:
            try:
                f = tkfont.Font(family=fam, size=self.FONT_SIZE)
                # Verify it actually loaded
                if f.actual("family") != fam and fam != self.FONT_FAMILY:
                    continue
                return (fam, self.FONT_SIZE)
            except Exception:
                continue
        return ("TkDefaultFont", self.FONT_SIZE)

    # ── Public API ───────────────────────────────────────────────

    def clear(self):
        """Remove all items and clear canvases."""
        self._items.clear()
        self._children = {"": []}
        self._visible_order.clear()
        self._selected_id = None
        self._canvas_objs.clear()
        self._canvas.delete("all")
        self._header_canvas.delete("all")
        self._canvas.configure(scrollregion=(0, 0, 0, 0))

    def add_item(self, item_id: str, text: str, *,
                 parent_id: str = "",
                 values: tuple = (),
                 icon: str = "",
                 is_leaf: bool = True,
                 is_open: bool = False):
        """Add a single item to the tree.

        Args:
            item_id: Unique identifier (UUID, "_cat_<path>", "_recent_")
            text: Display text for the tree column
            parent_id: Parent item_id, "" for root level
            values: Column values tuple
            icon: "folder", "key", "clock", or "" for no icon
            is_leaf: False for folders (shows toggle box)
            is_open: Initial expanded state (folders only)
        """
        info = ItemInfo(
            item_id=item_id, text=text, values=values, icon=icon,
            is_leaf=is_leaf, is_open=is_open and not is_leaf,
            parent_id=parent_id,
        )
        self._items[item_id] = info
        self._children.setdefault(parent_id, []).append(item_id)
        if not is_leaf:
            self._children.setdefault(item_id, [])

    def get_selection(self) -> Optional[str]:
        """Return the item_id of the selected row, or None."""
        return self._selected_id

    def set_selection(self, item_id: str):
        """Programmatically select a row."""
        if item_id not in self._items:
            return
        self._selected_id = item_id
        self.redraw()

    def get_children(self, parent_id: str = "") -> list[str]:
        """Return child item_ids for a parent."""
        return list(self._children.get(parent_id, []))

    def item(self, item_id: str, option: str, value=None):
        """Get/set item properties, mirroring ttk.Treeview.item() where useful."""
        info = self._items.get(item_id)
        if info is None:
            return None
        if option == "text":
            if value is not None:
                info.text = str(value)
            return info.text
        if option == "values":
            if value is not None:
                info.values = tuple(value)
            return info.values
        if option == "open":
            if value is not None:
                info.is_open = bool(value)
            return info.is_open
        if option == "tags":
            return ()
        return None

    def redraw(self):
        """Full redraw: recompute layout, clear canvas, render all visible items."""
        self._compute_visible_order()
        self._compute_layout()
        self._canvas.delete("all")
        self._canvas_objs.clear()

        # Determine canvas width
        cw = self._canvas.winfo_width()
        if cw <= 1:
            self.update_idletasks()
            cw = self._canvas.winfo_width()
        if cw <= 1:
            cw = 500

        # Draw column headers on fixed header canvas
        if self._columns:
            self._draw_column_headers(cw)

        # Draw each visible item on scrollable data canvas
        for item_id in self._visible_order:
            self._draw_item(item_id, cw)

        # Update scrollregion
        self._canvas.configure(scrollregion=(0, 0, cw, self._total_height))

        # Show/hide scrollbar — update_idletasks ensures accurate canvas height
        self.update_idletasks()
        visible_h = self._canvas.winfo_height()
        if self._total_height <= visible_h:
            self._scrollbar.pack_forget()
        else:
            if not self._scrollbar.winfo_ismapped():
                self._scrollbar.pack(side="right", fill="y")

    def selection_set(self, item_id: str):
        """Select an item (ttk.Treeview-compatible alias)."""
        self.set_selection(item_id)

    def selection(self) -> tuple:
        """Return selected item ids as tuple (ttk.Treeview-compatible)."""
        if self._selected_id:
            return (self._selected_id,)
        return ()

    def auto_fit_columns(self, max_width: int = 300):
        """Set column widths to fit the widest content in each column.
        Args:
            max_width: Maximum width any single column can take (pixels).
        """
        if not self._columns or not self._visible_order:
            return

        f = tkfont.Font(family=self._font[0], size=self._font[1])

        # Tree column (col 0): measure header text + indent + icon
        tree_text = "系统 / 目录"
        tree_w = f.measure(tree_text) + self.INDENT + 20 + 8  # indent + icon + padding

        # Measure widest text in each data column
        col_max = {i + 1: f.measure(name) for i, name in enumerate(self._columns)}

        for item_id in self._visible_order:
            info = self._items.get(item_id)
            if info is None:
                continue
            # Tree column: text at depth-based indent
            text_w = self._text_x(info.depth) + f.measure(info.text)
            if text_w > tree_w:
                tree_w = text_w
            # Data columns
            for i, val in enumerate(info.values):
                val_w = f.measure(str(val) if val else "")
                ci = i + 1
                if val_w > col_max.get(ci, 0):
                    col_max[ci] = val_w

        # Apply with padding and max limit
        tree_w = min(max(tree_w + 12, 80), max_width)
        self._col_widths[0] = tree_w
        for ci, w in col_max.items():
            self._col_widths[ci] = min(max(w + 16, 50), max_width)

    # ── Layout computation ───────────────────────────────────────

    def _compute_visible_order(self):
        """Depth-first walk of expanded items."""
        self._visible_order.clear()

        def walk(parent_id: str, depth: int):
            children = self._children.get(parent_id, [])
            for idx, child_id in enumerate(children):
                info = self._items.get(child_id)
                if info is None:
                    continue
                info.depth = depth
                info.is_last_sibling = (idx == len(children) - 1)
                self._visible_order.append(child_id)
                if not info.is_leaf and info.is_open:
                    walk(child_id, depth + 1)

        walk("", 0)

    def _compute_layout(self):
        """Assign y_offset to each visible item and compute total height."""
        y = 0  # data starts at 0 on data canvas (headers are separate)
        for item_id in self._visible_order:
            info = self._items.get(item_id)
            if info is None:
                continue
            info._y_offset = y
            y += self.ROW_HEIGHT
        self._total_height = y

    # ── Drawing ──────────────────────────────────────────────────

    def _draw_column_headers(self, cw):
        """Draw column header row on fixed header canvas."""
        self._header_canvas.delete("all")
        h = self.ROW_HEIGHT

        # Background
        self._header_canvas.create_rectangle(0, 0, cw, h, fill=self.HEADER_BG,
                                             outline="", tags=("header",))
        # Bottom separator
        self._header_canvas.create_line(0, h - 1, cw, h - 1,
                                        fill=self.SEP_COLOR, tags=("header",))

        tree_col_w = self._col_widths.get(0, 160)
        x = tree_col_w   # first data column starts right after tree column
        font_style = (self._font[0], self.FONT_SIZE, "bold")

        # Tree column header
        self._header_canvas.create_text(self.INDENT + 2, h // 2,
                                        text="系统 / 目录", anchor="w",
                                        font=font_style, fill="#333333",
                                        tags=("header", "header_text"))
        self._header_rects = [(0, 0, tree_col_w, h)]
        self._separator_xs = [tree_col_w]  # x positions for drag handles

        # Vertical separator after tree column
        self._header_canvas.create_line(tree_col_w, 0, tree_col_w, h,
                                        fill=self.SEP_COLOR, width=2, tags=("header",))

        # Additional columns
        for i, col_name in enumerate(self._columns):
            col_w = self._col_widths.get(i + 1, 110)
            x2 = x + col_w
            self._header_canvas.create_text(x + 4, h // 2,
                                            text=col_name, anchor="w",
                                            font=font_style, fill="#333333",
                                            tags=("header", "header_text"))
            self._header_rects.append((x, 0, x2, h))
            self._separator_xs.append(x2)
            # Vertical separator (2px wide for easier grabbing)
            self._header_canvas.create_line(x2, 0, x2, h,
                                            fill=self.SEP_COLOR, width=2, tags=("header",))
            x = x2

    def _draw_item(self, item_id: str, cw: int):
        """Draw a single row and collect canvas object IDs."""
        info = self._items.get(item_id)
        if info is None:
            return

        y = info._y_offset
        d = info.depth
        obj_ids = []

        tree_col_w = self._col_widths.get(0, 160)

        # ── 1. Background rectangle ──
        is_selected = (item_id == self._selected_id)
        stripe = self._stripe_index(item_id) is not None and self._stripe_index(item_id) % 2 == 1

        if is_selected:
            bg = self.SELECT_BG
        elif stripe:
            bg = self.STRIPE_BG
        else:
            bg = "white"
        rid = self._canvas.create_rectangle(0, y, cw, y + self.ROW_HEIGHT,
                                            fill=bg, outline="",
                                            tags=("row_bg", item_id))
        obj_ids.append(rid)

        # ── 2. Guide lines ──
        self._draw_guide_lines(info, y, obj_ids)

        # ── 3. Toggle box (folders only) ──
        if not info.is_leaf:
            tx = self._toggle_x(d)
            ty = y + (self.ROW_HEIGHT - self.TOGGLE_SIZE) // 2
            rid = self._canvas.create_rectangle(
                tx, ty, tx + self.TOGGLE_SIZE, ty + self.TOGGLE_SIZE,
                fill="#D0D0D0", outline="#808080",
                tags=("toggle", item_id))
            obj_ids.append(rid)
            symbol = "−" if info.is_open else "+"
            tid = self._canvas.create_text(
                tx + self.TOGGLE_SIZE // 2 + 1, ty + self.TOGGLE_SIZE // 2 + 1,
                text=symbol, font=(self._font[0], self.FONT_SIZE, "bold"),
                fill="#404040", anchor="center", tags=("toggle_text", item_id))
            obj_ids.append(tid)

        # ── 4. Horizontal connector ──
        if d > 0:
            hline_y = y + self.ROW_HEIGHT // 2
            parent_vx = self._vline_x(d - 1)

            if info.is_leaf:
                # No toggle box — one continuous dotted line to icon
                lid = self._canvas.create_line(
                    parent_vx, hline_y, self._icon_x(d) - 2, hline_y,
                    fill=self.LINE_COLOR, dash=self.LINE_DASH,
                    tags=("guide", item_id))
                obj_ids.append(lid)
            else:
                # Toggle box present — two segments around toggle
                toggle_left = self._toggle_x(d)
                toggle_right = toggle_left + self.TOGGLE_SIZE
                # Segment 1: parent vline → left of toggle
                lid = self._canvas.create_line(
                    parent_vx, hline_y, toggle_left, hline_y,
                    fill=self.LINE_COLOR, dash=self.LINE_DASH,
                    tags=("guide", item_id))
                obj_ids.append(lid)
                # Segment 2: right of toggle → just before icon
                lid = self._canvas.create_line(
                    toggle_right, hline_y, self._icon_x(d) - 2, hline_y,
                    fill=self.LINE_COLOR, dash=self.LINE_DASH,
                    tags=("guide", item_id))
                obj_ids.append(lid)

        # ── 5. Icon ──
        icon_x = self._icon_x(d)
        icon_y = y + (self.ROW_HEIGHT - 20) // 2 + 1
        icon_img = self._icon_cache.get(info.icon)
        if icon_img:
            iid = self._canvas.create_image(icon_x, icon_y, image=icon_img,
                                            anchor="nw", tags=("icon", item_id))
            obj_ids.append(iid)

        # ── 6. Tree column text ──
        text_x = self._text_x(d)
        text_color = self.SELECT_FG if is_selected else "#1f1f1f"
        text_y = y + self.ROW_HEIGHT // 2 + 1
        display_text = self._truncate_text(info.text, tree_col_w - (text_x), self._font)
        tid = self._canvas.create_text(text_x, text_y, text=display_text,
                                       anchor="w", font=self._font,
                                       fill=text_color, tags=("text", item_id))
        obj_ids.append(tid)

        # ── 7. Additional column values ──
        col_x = tree_col_w
        for i, val in enumerate(info.values):
            col_w = self._col_widths.get(i + 1, 110)
            col_text = self._truncate_text(str(val) if val else "", col_w - 8, self._font)
            tid = self._canvas.create_text(col_x + 4, text_y, text=col_text,
                                           anchor="w", font=self._font,
                                           fill=text_color, tags=("coltext", item_id))
            obj_ids.append(tid)
            # Vertical separator
            sid = self._canvas.create_line(col_x + col_w, y, col_x + col_w,
                                           y + self.ROW_HEIGHT,
                                           fill=self.SEP_COLOR, tags=("sep",))
            obj_ids.append(sid)
            col_x += col_w

        self._canvas_objs[item_id] = obj_ids

    def _draw_guide_lines(self, info: ItemInfo, y: int, obj_ids: list):
        """Draw dotted vertical guide lines from ancestors."""
        d = info.depth
        if d == 0:
            return

        for ancestor_depth in range(d):
            lineage_child_id = self._get_ancestor_at_depth(info.item_id, ancestor_depth + 1)
            if lineage_child_id is None:
                continue
            lineage_info = self._items.get(lineage_child_id)
            if lineage_info is None:
                continue

            is_last_in_lineage = lineage_info.is_last_sibling
            vline_x = self._vline_x(ancestor_depth)

            if not is_last_in_lineage:
                # Line continues through this row
                lid = self._canvas.create_line(
                    vline_x, y, vline_x, y + self.ROW_HEIGHT,
                    fill=self.LINE_COLOR, dash=self.LINE_DASH,
                    tags=("guide", info.item_id))
                obj_ids.append(lid)
            else:
                # Line stops at the middle of this row (L-shape end)
                lid = self._canvas.create_line(
                    vline_x, y, vline_x, y + self.ROW_HEIGHT // 2,
                    fill=self.LINE_COLOR, dash=self.LINE_DASH,
                    tags=("guide", info.item_id))
                obj_ids.append(lid)

    def _get_ancestor_at_depth(self, item_id: str, depth: int) -> Optional[str]:
        """Walk up parent chain to find the item at a given depth."""
        info = self._items.get(item_id)
        while info is not None and info.depth > depth:
            info = self._items.get(info.parent_id)
        if info is not None and info.depth == depth:
            return info.item_id
        return None

    def _truncate_text(self, text: str, max_pixels: int, font_spec) -> str:
        """Truncate text with ellipsis if it exceeds pixel width."""
        if max_pixels <= 0:
            return ""
        f = tkfont.Font(family=font_spec[0], size=font_spec[1])
        if f.measure(text) <= max_pixels:
            return text
        ellipsis = "…"
        while len(text) > 0 and f.measure(text + ellipsis) > max_pixels:
            text = text[:-1]
        return text + ellipsis if text else ellipsis

    # ── Stripe index ─────────────────────────────────────────────

    def _stripe_index(self, item_id: str) -> Optional[int]:
        """Return the 0-based index among leaf entries, or None for folders."""
        info = self._items.get(item_id)
        if info is None or not info.is_leaf:
            return None
        idx = 0
        for vid in self._visible_order:
            vinfo = self._items.get(vid)
            if vinfo is None:
                continue
            if vid == item_id:
                return idx
            if vinfo.is_leaf:
                idx += 1
        return None

    # ── Hit testing ──────────────────────────────────────────────

    def _hit_test(self, canvas_x: int, canvas_y: int):
        """Return (item_id, 'toggle' | 'row' | None)."""
        row_idx = int(canvas_y) // self.ROW_HEIGHT
        if row_idx < 0 or row_idx >= len(self._visible_order):
            return None, None

        item_id = self._visible_order[row_idx]
        info = self._items.get(item_id)
        if info is None:
            return None, None

        # Check if click is on toggle box
        if not info.is_leaf:
            tx = self._toggle_x(info.depth)
            ty_rel = int(canvas_y) % self.ROW_HEIGHT
            ty_box = (self.ROW_HEIGHT - self.TOGGLE_SIZE) // 2
            if (tx <= canvas_x <= tx + self.TOGGLE_SIZE and
                    ty_box <= ty_rel <= ty_box + self.TOGGLE_SIZE):
                return item_id, "toggle"

        return item_id, "row"

    # ── Scroll to item ───────────────────────────────────────────

    def _scroll_to_item(self, item_id: str):
        """Scroll canvas so the given item is visible."""
        info = self._items.get(item_id)
        if info is None:
            return
        y = info._y_offset
        canvas_h = self._canvas.winfo_height()
        if canvas_h <= 0:
            return
        total_h = self._total_height
        if total_h <= canvas_h:
            return
        fraction = max(0, (y - canvas_h // 2)) / (total_h - canvas_h)
        fraction = min(fraction, 1.0)
        self._canvas.yview_moveto(fraction)

    # ── Event handlers ───────────────────────────────────────────

    def _on_click(self, event):
        self._canvas.focus_set()
        # Use manual scroll-offset instead of canvasy() for cross-platform reliability
        yv = self._canvas.yview()
        scroll_offset = int(yv[0] * self._total_height) if self._total_height > 0 else 0
        canvas_y = event.y + scroll_offset
        canvas_x = event.x  # no horizontal scroll

        item_id, kind = self._hit_test(canvas_x, canvas_y)

        if item_id is None:
            return

        if kind == "toggle":
            self._toggle_item(item_id)
            return

        # Row selection
        if item_id != self._selected_id:
            self._selected_id = item_id
            self.redraw()
            if self._on_select:
                self._on_select(item_id)

    def _on_header_press(self, event):
        """Header mousedown — start drag if near separator, else sort column."""
        x = event.x
        # Check if near any separator (within 5px)
        SEP_GRAB = 5
        for i, sx in enumerate(self._separator_xs):
            if abs(x - sx) <= SEP_GRAB:
                # Start dragging this separator (column i)
                self._drag_col = i
                self._drag_start_x = event.x_root
                self._drag_start_width = self._col_widths.get(i, 110)
                self._header_canvas.configure(cursor="sb_h_double_arrow")
                return

        # Not near a separator — sort column
        if self._on_header_click and self._header_rects:
            for i, (x1, y1, x2, y2) in enumerate(self._header_rects):
                if x1 <= x <= x2:
                    self._on_header_click(i)
                    return

    def _on_header_drag(self, event):
        """Drag column separator to resize."""
        if self._drag_col is None:
            return
        delta = event.x_root - self._drag_start_x
        new_width = max(self._drag_min_width, self._drag_start_width + delta)
        self._col_widths[self._drag_col] = new_width
        self.redraw()

    def _on_header_release(self, event):
        """Stop column drag."""
        self._drag_col = None
        self._header_canvas.configure(cursor="")

    def _on_double(self, event):
        canvas_y = event.y + int(self._canvas.yview()[0] * self._total_height) if self._total_height > 0 else event.y
        item_id, kind = self._hit_test(event.x, canvas_y)
        if item_id and kind == "row":
            if self._on_double_click:
                self._on_double_click(item_id)

    def _on_right(self, event):
        canvas_y = event.y + int(self._canvas.yview()[0] * self._total_height) if self._total_height > 0 else event.y
        item_id, kind = self._hit_test(event.x, canvas_y)

        if item_id and kind == "row":
            # Select the item first
            if item_id != self._selected_id:
                self._selected_id = item_id
                self.redraw()
                if self._on_select:
                    self._on_select(item_id)
            if self._on_right_click:
                self._on_right_click(item_id, event.x_root, event.y_root)
        elif kind is None and self._on_empty_right_click:
            # Right-click on empty area
            self._on_empty_right_click(event.x_root, event.y_root)

    def _on_context_menu(self, event):
        """Keyboard-triggered context menu."""
        if self._selected_id and self._on_right_click:
            info = self._items.get(self._selected_id)
            if info:
                # Estimate screen coordinates
                y = info._y_offset
                self._on_right_click(self._selected_id,
                                     self.winfo_rootx() + 100,
                                     self.winfo_rooty() + y + self.ROW_HEIGHT)

    def _toggle_item(self, item_id: str):
        info = self._items.get(item_id)
        if info is None or info.is_leaf:
            return
        info.is_open = not info.is_open
        self.redraw()
        if self._on_toggle:
            self._on_toggle(item_id, info.is_open)

    # ── Keyboard navigation ──────────────────────────────────────

    def _on_key_up(self, event):
        if not self._visible_order:
            return
        if self._selected_id is None:
            idx = 0
        else:
            try:
                idx = self._visible_order.index(self._selected_id)
                idx = max(0, idx - 1)
            except ValueError:
                idx = 0
        self._selected_id = self._visible_order[idx]
        self.redraw()
        self._scroll_to_item(self._selected_id)
        if self._on_select:
            self._on_select(self._selected_id)

    def _on_key_down(self, event):
        if not self._visible_order:
            return
        if self._selected_id is None:
            idx = 0
        else:
            try:
                idx = self._visible_order.index(self._selected_id)
                idx = min(len(self._visible_order) - 1, idx + 1)
            except ValueError:
                idx = 0
        self._selected_id = self._visible_order[idx]
        self.redraw()
        self._scroll_to_item(self._selected_id)
        if self._on_select:
            self._on_select(self._selected_id)

    def _on_key_enter(self, event):
        if self._selected_id and self._on_double_click:
            self._on_double_click(self._selected_id)

    def _on_key_left(self, event):
        """Collapse selected folder, or move to parent."""
        if self._selected_id is None:
            return
        info = self._items.get(self._selected_id)
        if info and not info.is_leaf and info.is_open:
            info.is_open = False
            self.redraw()
            if self._on_toggle:
                self._on_toggle(self._selected_id, False)
        elif info and info.parent_id:
            self._selected_id = info.parent_id
            self.redraw()
            self._scroll_to_item(self._selected_id)
            if self._on_select:
                self._on_select(self._selected_id)

    def _on_key_right_(self, event):
        """Expand selected folder, or move to first child."""
        if self._selected_id is None:
            return
        info = self._items.get(self._selected_id)
        if info and not info.is_leaf and not info.is_open:
            info.is_open = True
            self.redraw()
            if self._on_toggle:
                self._on_toggle(self._selected_id, True)
        elif info and not info.is_leaf:
            children = self._children.get(self._selected_id, [])
            if children:
                self._selected_id = children[0]
                self.redraw()
                self._scroll_to_item(self._selected_id)
                if self._on_select:
                    self._on_select(self._selected_id)

    # ── Scrolling ────────────────────────────────────────────────

    def _on_mousewheel(self, event):
        """Windows mousewheel — only scroll when scrollbar is visible."""
        if not self._scrollbar.winfo_ismapped():
            return
        delta = -1 * (event.delta // 120)
        self._canvas.yview_scroll(delta, "units")

    # ── Resize ───────────────────────────────────────────────────

    def _on_resize(self, event):
        """Handle data canvas resize — redraw if we have items."""
        if self._visible_order and event.width > 1:
            self._compute_layout()
            self._canvas.delete("all")
            self._canvas_objs.clear()
            cw = event.width
            if self._columns:
                self._draw_column_headers(cw)
            for item_id in self._visible_order:
                self._draw_item(item_id, cw)
            self._canvas.configure(scrollregion=(0, 0, cw, self._total_height))
            # Update scrollbar visibility after resize
            self.update_idletasks()
            if self._total_height <= self._canvas.winfo_height():
                self._scrollbar.pack_forget()
            else:
                if not self._scrollbar.winfo_ismapped():
                    self._scrollbar.pack(side="right", fill="y")


# ── Standalone test ──────────────────────────────────────────────

if __name__ == "__main__":
    root = tk.Tk()
    root.title("ExplorerTree Test — Windows XP Style")
    root.geometry("700x500")
    root.configure(bg="white")

    tree = ExplorerTree(
        root,
        columns=("用户名", "网址"),
        column_widths={0: 200, 1: 130, 2: 170},
        on_select=lambda iid: print(f"Selected: {iid}"),
        on_toggle=lambda iid, state: print(f"Toggle: {iid} → {state}"),
        on_double_click=lambda iid: print(f"Double-click: {iid}"),
        on_right_click=lambda iid, x, y: print(f"Right-click: {iid} at ({x},{y})"),
        on_header_click=lambda col: print(f"Header click: col {col}"),
    )
    tree.pack(fill="both", expand=True)

    # Populate with example data matching user's spec
    tree.add_item("db", "Database", icon="folder", is_leaf=False, is_open=True)

    tree.add_item("db_bookmarks", "Bookmarks", parent_id="db", icon="folder",
                  is_leaf=False, is_open=True)

    tree.add_item("db_ftp", "FTP", parent_id="db", icon="folder",
                  is_leaf=False, is_open=True)

    tree.add_item("db_nas", "NAS", parent_id="db", icon="folder",
                  is_leaf=False, is_open=True)
    tree.add_item("core_nas", "Core_NAS", parent_id="db_nas", icon="key",
                  is_leaf=True, values=("admin", "https://nas.local"))
    tree.add_item("storage_cluster", "StorageCluster", parent_id="db_nas", icon="key",
                  is_leaf=True, values=("operator", "https://cluster.local"))
    tree.add_item("storage_web", "StorageWeb", parent_id="db_nas", icon="key",
                  is_leaf=True, values=("webadmin", "https://storageweb.local"))

    tree.add_item("db_office", "office", parent_id="db", icon="folder",
                  is_leaf=False, is_open=True)

    tree.add_item("db_pin", "PIN Numbers", parent_id="db", icon="folder",
                  is_leaf=False, is_open=False)

    tree.add_item("db_vmware", "Vmware", parent_id="db", icon="folder",
                  is_leaf=False, is_open=True)
    tree.add_item("vmware", "VMware", parent_id="db_vmware", icon="key",
                  is_leaf=True, values=("root", "https://vmware.local"))

    tree.add_item("db_dongxihu", "东西湖", parent_id="db", icon="folder",
                  is_leaf=False, is_open=True)
    tree.add_item("fortress", "堡垒机", parent_id="db_dongxihu", icon="key",
                  is_leaf=True, values=("ops", "https://fortress.local"))
    tree.add_item("firewall", "出口防火墙", parent_id="db_dongxihu", icon="key",
                  is_leaf=True, values=("netadmin", "https://fw.local"))

    tree.add_item("db_cq", "重庆办公室", parent_id="db", icon="folder",
                  is_leaf=False, is_open=True)
    tree.add_item("sw", "上网行为管理", parent_id="db_cq", icon="key",
                  is_leaf=True, values=("admin", "https://sw.local"))
    tree.add_item("sangfor", "深信服VPN", parent_id="db_cq", icon="key",
                  is_leaf=True, values=("vpnuser", "https://vpn.local"))
    tree.add_item("tianqing", "天擎", parent_id="db_cq", icon="key",
                  is_leaf=True, values=("secadmin", "https://tq.local"))

    tree.redraw()
    # Select StorageWeb by default
    tree.set_selection("storage_web")

    root.mainloop()
