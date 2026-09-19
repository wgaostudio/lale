/**
 * LaTeX fragments from the parsed document are rendered to HTML strings and
 * injected with dangerouslySetInnerHTML. Everything outside a math delimiter is
 * escaped here, and KaTeX runs with trust: false, so no author-controlled markup
 * reaches the DOM.
 */
import katex from 'katex';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#039;';
      default:
        return char;
    }
  });
}

function renderMath(source: string, displayMode: boolean): string {
  return katex.renderToString(source, {
    displayMode,
    throwOnError: false,
    strict: false,
    trust: false,
  });
}

function renderDelimitedMath(source: string): string {
  const parts: string[] = [];
  let rest = source;

  while (rest.length > 0) {
    const match = rest.match(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\$([^$]+)\$/);
    if (!match || match.index == null) {
      parts.push(escapeHtml(rest));
      break;
    }

    parts.push(escapeHtml(rest.slice(0, match.index)));
    const math = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
    const displayMode = match[0].startsWith('\\[') || match[0].startsWith('$$');
    parts.push(renderMath(math, displayMode));
    rest = rest.slice(match.index + match[0].length);
  }

  return parts.join('');
}

function renderTextMacros(source: string): string {
  return source
    .replace(/\\emph\{([^{}]+)\}/g, '<em>$1</em>')
    .replace(/\\textbf\{([^{}]+)\}/g, '<strong>$1</strong>')
    .replace(/\\textit\{([^{}]+)\}/g, '<em>$1</em>')
    .replace(/\\ref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\cref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\Cref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\autoref\{([^{}]+)\}/g, '<code>$1</code>')
    .replace(/\\eqref\{([^{}]+)\}/g, '<code>($1)</code>');
}

// Marks a paragraph break across rendering. A literal newline cannot: `\s+`
// collapsing runs before the math pass, and it used to run in compact and block
// mode alike — so the `<br>` substitution that followed had nothing left to
// match and a multi-paragraph proof rendered as one unbroken wall.
const PARAGRAPH_BREAK = '\u0000';

export function renderLatexProse(source: string, options: { compact?: boolean } = {}): string {
  const normalized = options.compact
    ? source.replace(/\s+/g, ' ').trim()
    : source.replace(/\n[ \t]*\n\s*/g, PARAGRAPH_BREAK).replace(/\s+/g, ' ').trim();
  const withTextMacros = renderTextMacros(renderDelimitedMath(normalized));
  return options.compact
    ? withTextMacros
    : withTextMacros.split(PARAGRAPH_BREAK).filter(Boolean).join('<br><br>');
}

export function renderLatexInline(source: string): string {
  return renderLatexProse(source, { compact: true });
}
