import DOMPurify from 'dompurify';

// Allowed URL schemes (block javascript:, data:, etc.)
const ALLOWED_SCHEMES = ['http:', 'https:', 'mailto:', 'ftp:', 'ftps:'];

function safeUrl(url) {
  try {
    const u = new URL(url.trim());
    if (!ALLOWED_SCHEMES.includes(u.protocol)) return '';
    return url;
  } catch {
    return url.startsWith('/') || url.startsWith('#') || url.startsWith('./') ? url : '';
  }
}

export default function MarkdownRenderer({ content }) {
  if (!content || typeof content !== 'string') return null;
  const html = DOMPurify.sanitize(renderMarkdown(content), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4',
      'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'hr', 'a', 'img'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'class'],
  });
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
  // Extract code blocks first to avoid double-escaping their content
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  html = escapeHtml(html);

  // Restore code blocks
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Images — validate src URL
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const safe = safeUrl(url);
    return safe ? `<img src="${safe}" alt="${escapeHtml(alt)}" />` : `![${alt}](${url})`;
  });

  // Links — validate href URL
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safe = safeUrl(url);
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `[${label}](${url})`;
  });

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Unordered lists
  html = html.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Paragraphs: double newlines
  const paragraphs = html.split('\n\n');
  html = paragraphs.map(p => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (/^<(h[1-4]|ul|ol|li|pre|blockquote|hr|img)/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}
