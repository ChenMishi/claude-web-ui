import DOMPurify from 'dompurify';
import { PrismLight as Prism } from 'react-syntax-highlighter';

// Lazy-register languages on first use
const langCache = new Set();
function ensureLang(lang) {
  const key = (lang || 'text').toLowerCase();
  if (langCache.has(key)) return;
  langCache.add(key);
  try {
    switch (key) {
      case 'js': case 'javascript': Prism.registerLanguage('javascript', require('react-syntax-highlighter/dist/esm/languages/prism/javascript').default); break;
      case 'ts': case 'typescript': Prism.registerLanguage('typescript', require('react-syntax-highlighter/dist/esm/languages/prism/typescript').default); break;
      case 'jsx': Prism.registerLanguage('jsx', require('react-syntax-highlighter/dist/esm/languages/prism/jsx').default); break;
      case 'tsx': Prism.registerLanguage('tsx', require('react-syntax-highlighter/dist/esm/languages/prism/tsx').default); break;
      case 'json': Prism.registerLanguage('json', require('react-syntax-highlighter/dist/esm/languages/prism/json').default); break;
      case 'python': case 'py': Prism.registerLanguage('python', require('react-syntax-highlighter/dist/esm/languages/prism/python').default); break;
      case 'bash': case 'shell': case 'sh': Prism.registerLanguage('bash', require('react-syntax-highlighter/dist/esm/languages/prism/bash').default); break;
      case 'css': Prism.registerLanguage('css', require('react-syntax-highlighter/dist/esm/languages/prism/css').default); break;
      case 'html': case 'xml': Prism.registerLanguage('markup', require('react-syntax-highlighter/dist/esm/languages/prism/markup').default); break;
      case 'sql': Prism.registerLanguage('sql', require('react-syntax-highlighter/dist/esm/languages/prism/sql').default); break;
      case 'yaml': case 'yml': Prism.registerLanguage('yaml', require('react-syntax-highlighter/dist/esm/languages/prism/yaml').default); break;
      case 'go': Prism.registerLanguage('go', require('react-syntax-highlighter/dist/esm/languages/prism/go').default); break;
      case 'rust': Prism.registerLanguage('rust', require('react-syntax-highlighter/dist/esm/languages/prism/rust').default); break;
      case 'java': Prism.registerLanguage('java', require('react-syntax-highlighter/dist/esm/languages/prism/java').default); break;
      case 'ruby': Prism.registerLanguage('ruby', require('react-syntax-highlighter/dist/esm/languages/prism/ruby').default); break;
      case 'c': Prism.registerLanguage('c', require('react-syntax-highlighter/dist/esm/languages/prism/c').default); break;
      case 'cpp': case 'c++': Prism.registerLanguage('cpp', require('react-syntax-highlighter/dist/esm/languages/prism/cpp').default); break;
      case 'markdown': case 'md': Prism.registerLanguage('markdown', require('react-syntax-highlighter/dist/esm/languages/prism/markdown').default); break;
      case 'diff': Prism.registerLanguage('diff', require('react-syntax-highlighter/dist/esm/languages/prism/diff').default); break;
      case 'dockerfile': case 'docker': Prism.registerLanguage('docker', require('react-syntax-highlighter/dist/esm/languages/prism/docker').default); break;
      case 'nginx': Prism.registerLanguage('nginx', require('react-syntax-highlighter/dist/esm/languages/prism/nginx').default); break;
      case 'makefile': Prism.registerLanguage('makefile', require('react-syntax-highlighter/dist/esm/languages/prism/makefile').default); break;
      case 'graphql': Prism.registerLanguage('graphql', require('react-syntax-highlighter/dist/esm/languages/prism/graphql').default); break;
      default: break;
    }
  } catch {}
}

function highlightCode(code, lang) {
  ensureLang(lang);
  const key = (lang || 'text').toLowerCase();
  try {
    if (!Prism.languages[key]) return escapeHtml(code);
    return Prism.highlight(code, Prism.languages[key], key);
  } catch {
    return escapeHtml(code);
  }
}

// Allowed URL schemes
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

export default function MarkdownRenderer({ content, streaming }) {
  if (!content || typeof content !== 'string') return null;

  // 流式输出时，检测末尾未闭合的代码块
  let liveCodeBlock = null;
  let renderContent = content;
  if (streaming) {
    liveCodeBlock = extractLiveCodeBlock(content);
    if (liveCodeBlock) {
      renderContent = liveCodeBlock.before;
    }
  }

  const html = DOMPurify.sanitize(renderMarkdown(renderContent), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4',
      'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'hr', 'a', 'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'src', 'alt', 'class'],
  });

  if (liveCodeBlock) {
    return (
      <div className="markdown-body">
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <pre className="live-code-block"><code className={`language-${liveCodeBlock.lang}`}>{liveCodeBlock.code}<span className="live-cursor">▍</span></code></pre>
      </div>
    );
  }

  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

// 检测流式输出中末尾未闭合的代码块
function extractLiveCodeBlock(text) {
  const lastFence = text.lastIndexOf('```');
  if (lastFence === -1) return null;

  const afterLast = text.slice(lastFence + 3);
  // 后面还有 ``` → 代码块已闭合
  if (afterLast.includes('```')) return null;

  // 确保 ``` 在行首或前面是换行（排除行内 ``` 的情况）
  if (lastFence > 0 && text[lastFence - 1] !== '\n') return null;

  const before = text.slice(0, lastFence);
  const newlineIdx = afterLast.indexOf('\n');
  const lang = newlineIdx === -1 ? afterLast.trim() : afterLast.slice(0, newlineIdx).trim();
  const code = newlineIdx === -1 ? '' : afterLast.slice(newlineIdx + 1);

  return { before, lang: lang || 'text', code };
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMarkdown(text) {
  // Step 1: Extract code blocks and highlight them
  const codeBlocks = [];
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="language-${lang || 'text'}">${highlightCode(code.trim(), lang)}</code></pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Step 2: Escape all remaining text
  html = escapeHtml(html);

  // Step 3: Process block-level elements (on escaped text)
  const lines = html.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block placeholder — pass through
    if (line.startsWith('\x00CB')) {
      output.push(line);
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      output.push('');
      i++;
      continue;
    }

    // Table: lines that start and end with |
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      output.push(renderTable(tableLines));
      continue;
    }

    // Headings: # through ######
    const headingMatch = line.match(/^(#{1,6}) (.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      output.push(`<h${level}>${headingMatch[2]}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule: ---, ***, ___
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      output.push('<hr>');
      i++;
      continue;
    }

    // Blockquote: &gt; (escaped from >)
    if (line.startsWith('&gt; ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].startsWith('&gt; ')) {
        quoteLines.push(lines[i].slice(6)); // remove '&gt; '
        i++;
      }
      output.push(`<blockquote>${quoteLines.join('<br>')}</blockquote>`);
      continue;
    }

    // Ordered list: 1. 2. 3. etc
    if (/^\d+\.\s+.+/.test(line)) {
      const listLines = [];
      while (i < lines.length && /^\d+\.\s+.+/.test(lines[i])) {
        listLines.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      output.push(`<ol>${listLines.map(l => `<li>${l}</li>`).join('')}</ol>`);
      continue;
    }

    // Unordered list (flat or nested): - or * item
    if (/^[\s]*[-*]\s+.+/.test(line)) {
      const listItems = [];
      while (i < lines.length && /^[\s]*[-*]\s+.+/.test(lines[i])) {
        listItems.push(lines[i]);
        i++;
      }
      output.push(renderNestedList(listItems));
      continue;
    }

    // Regular paragraph — collect until blank line or next block element
    const paraLines = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '' || l.startsWith('\x00CB') ||
          /^(#{1,6})\s/.test(l) || /^[-*_]{3,}\s*$/.test(l.trim()) ||
          l.startsWith('&gt; ') || /^\d+\.\s+/.test(l) ||
          /^[\s]*[-*]\s+/.test(l) ||
          (l.trim().startsWith('|') && l.trim().endsWith('|'))) {
        break;
      }
      paraLines.push(l);
      i++;
    }
    if (paraLines.length > 0) {
      output.push(`<p>${paraLines.join('<br>')}</p>`);
    }
  }

  html = output.join('\n');

  // Step 4: Restore highlighted code blocks
  html = html.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  // Step 5: Inline formatting
  // Inline code (must be before bold/italic)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
    const safe = safeUrl(url);
    return safe ? `<img src="${safe}" alt="${escapeHtml(alt)}" />` : `![${alt}](${url})`;
  });

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const safe = safeUrl(url);
    return safe
      ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : `[${label}](${url})`;
  });

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*\*/g, '<strong>*$1</strong>');
  html = html.replace(/\*\*\*(.+?)\*\*/g, '<strong>$1*</strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  return html;
}

function renderTable(lines) {
  if (lines.length < 2) return '';
  const parseRow = (line) => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const header = parseRow(lines[0]);
  const bodyStart = lines[1] && /^[\s|:\-]+$/.test(lines[1].replace(/\|/g, '')) ? 2 : 1;
  const bodyRows = lines.slice(bodyStart).map(parseRow);

  let tableHtml = '<thead><tr>';
  for (const h of header) tableHtml += `<th>${h}</th>`;
  tableHtml += '</tr></thead><tbody>';
  for (const row of bodyRows) {
    tableHtml += '<tr>';
    for (let c = 0; c < header.length; c++) {
      tableHtml += `<td>${row[c] || ''}</td>`;
    }
    tableHtml += '</tr>';
  }
  tableHtml += '</tbody>';
  return `<table>${tableHtml}</table>`;
}

function renderNestedList(items) {
  function build(list, indent) {
    const result = [];
    let i = 0;
    while (i < list.length) {
      const match = list[i].match(/^(\s*)[-*]\s+(.+)/);
      if (!match) { i++; continue; }
      const itemIndent = match[1].length;
      const content = match[2];

      if (itemIndent > indent) {
        // Nested sublist belongs to the previous parent item
        const subItems = [];
        while (i < list.length) {
          const sm = list[i].match(/^(\s*)[-*]\s+(.+)/);
          if (!sm || sm[1].length <= indent) break;
          subItems.push(list[i]);
          i++;
        }
        const lastIdx = result.length - 1;
        if (lastIdx >= 0 && result[lastIdx].endsWith('</li>')) {
          result[lastIdx] = result[lastIdx].replace(/<\/li>$/, '');
          result[lastIdx] += build(subItems, itemIndent) + '</li>';
        }
      } else if (itemIndent === indent) {
        result.push(`<li>${content}</li>`);
        i++;
      } else {
        break; // dedent
      }
    }
    return `<ul>${result.join('')}</ul>`;
  }
  return build(items, 0);
}
