// ── Shared file icon SVGs ──

const S = { w: 14, h: 14, v: '0 0 24 24', f: 'none', s: 'currentColor', sw: 2, lc: 'round', lj: 'round' };

function Svg(d) {
  return <svg width={S.w} height={S.h} viewBox={S.v} fill={S.f} stroke={S.s} strokeWidth={S.sw} strokeLinecap={S.lc} strokeLinejoin={S.lj}>{d}</svg>;
}

export function getFileIcon(fileName) {
  const n = fileName.toLowerCase();
  // Image
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|ico)$/i.test(n)) {
    return Svg(<><rect x="1" y="6" width="22" height="16" rx="2" ry="2" /><circle cx="12" cy="14" r="4" /><path d="M9 3h6l2 3h4a2 2 0 0 1 2 2" /></>);
  }
  // Archive / compressed
  if (/\.(zip|tar|gz|tgz|7z|rar|bz2|xz)$/i.test(n) || /\.tar\.\w+$/i.test(n)) {
    return Svg(<><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /><polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" /></>);
  }
  // Spreadsheet
  if (/\.(xlsx|xls|csv|tsv)$/i.test(n)) {
    return Svg(<><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></>);
  }
  // PDF
  if (/\.pdf$/i.test(n)) {
    return Svg(<><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /><path d="M9 13h1.5c1 0 2 .5 2 1.5s-1 1.5-2 1.5H9v3" /></>);
  }
  // Code
  if (/\.(py|js|jsx|ts|tsx|css|scss|less|html|htm|json|xml|yaml|yml|toml|go|rs|rb|java|c|cpp|h|hpp|sql|sh|bash|zsh|ps1|bat|php|swift|kt|r|dart|lua|vim|cfg|ini|env|dockerfile|makefile|cmake)$/i.test(n)) {
    return Svg(<><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>);
  }
  // Document (Word / PPT / text)
  if (/\.(docx|doc|pptx|ppt|txt|md|log|rtf)$/i.test(n)) {
    return Svg(<><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></>);
  }
  // Default file
  return Svg(<><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></>);
}
