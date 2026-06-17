// ── Shared file icon SVGs ──
// Each file type gets a distinct brand color + filled style for visual differentiation

const COLORS = {
  image:       '#3B82F6',   // blue
  archive:     '#D97706',   // amber
  spreadsheet: '#059669',   // emerald
  pdf:         '#DC2626',   // red
  code:        '#6366F1',   // indigo
  document:    '#475569',   // slate
  default:     '#6B7280',   // gray
};

function Svg({ d, color, fillOpacity, strokeWidth }) {
  const c = color || COLORS.default;
  return (
    <svg width={16} height={16} viewBox="0 0 24 24"
      fill="none" stroke={c} strokeWidth={strokeWidth ?? 2}
      strokeLinecap="round" strokeLinejoin="round"
    >
      {d}
    </svg>
  );
}

export function getFileIcon(fileName) {
  const n = fileName.toLowerCase();
  const c = COLORS;

  // Image — filled camera
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|ico)$/i.test(n)) {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.image} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" fill={c.image} fillOpacity={0.15} />
        <circle cx="12" cy="13" r="4" fill={c.image} fillOpacity={0.3} />
      </svg>
    );
  }

  // Archive — filled box
  if (/\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i.test(n) || /\.tar\.\w+$/i.test(n)) {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.archive} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" fill={c.archive} fillOpacity={0.15} />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    );
  }

  // Spreadsheet — filled grid
  if (/\.(xlsx|xls|csv|tsv)$/i.test(n)) {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.spreadsheet} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" fill={c.spreadsheet} fillOpacity={0.12} />
        <rect x="3" y="9" width="18" height="6" fill={c.spreadsheet} fillOpacity={0.15} />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="3" y1="15" x2="21" y2="15" />
        <line x1="9" y1="3" x2="9" y2="21" />
        <line x1="15" y1="3" x2="15" y2="21" />
      </svg>
    );
  }

  // PDF — filled doc with red accent
  if (/\.pdf$/i.test(n)) {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.pdf} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill={c.pdf} fillOpacity={0.15} />
        <polyline points="14 2 14 8 20 8" fill={c.pdf} fillOpacity={0.25} />
        <path d="M9 13h1.5c1 0 2 .5 2 1.5s-1 1.5-2 1.5H9v3" fill={c.pdf} fillOpacity={0.15} />
      </svg>
    );
  }

  // Code — angle brackets
  if (/\.(py|js|jsx|ts|tsx|css|scss|less|html|htm|json|xml|yaml|yml|toml|go|rs|rb|java|c|cpp|h|hpp|sql|sh|bash|zsh|ps1|bat|php|swift|kt|r|dart|lua|vim|cfg|ini|env|dockerfile|makefile|cmake)$/i.test(n)) {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.code} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    );
  }

  // Document (Word / PPT / text)
  if (/\.(docx|doc|pptx|ppt|txt|md|log|rtf)$/i.test(n)) {
    return (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.document} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill={c.document} fillOpacity={0.15} />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </svg>
    );
  }

  // Default file
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={c.default} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill={c.default} fillOpacity={0.12} />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
