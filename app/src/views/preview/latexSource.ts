// A LaTeX source file, made readable: structure becomes headings and lists,
// maths stays as LaTeX for the typesetter, and preamble noise is dropped.
export function texToMarkdown(source: string): string {
  let text = source.replace(/(^|[^\\])%.*$/gm, '$1');
  const title = text.match(/\\title\{([^}]*)\}/)?.[1];
  const body = text.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  text = body ? body[1] : text;
  text = text.replace(/\\maketitle/g, '')
    .replace(/\\(?:sub){2}section\*?\{([^}]*)\}/g, '\n### $1\n').replace(/\\subsection\*?\{([^}]*)\}/g, '\n## $1\n').replace(/\\section\*?\{([^}]*)\}/g, '\n# $1\n')
    .replace(/\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}([\s\S]*?)\\end\{\1\2\}/g, (_match, env, _star, inner) =>
      `\n$$\n${env === 'equation' || env === 'multline' ? inner.trim() : `\\begin{aligned}${inner.trim()}\\end{aligned}`}\n$$\n`)
    .replace(/\\begin\{(?:itemize|enumerate)\}|\\end\{(?:itemize|enumerate)\}/g, '\n').replace(/^\s*\\item\s*/gm, '- ')
    .replace(/\\(?:textbf|bf)\{([^}]*)\}/g, '**$1**').replace(/\\(?:textit|emph)\{([^}]*)\}/g, '*$1*').replace(/\\texttt\{([^}]*)\}/g, '`$1`')
    .replace(/\\(?:label|cite|ref|usepackage|documentclass|author|date|noindent|centering|newpage|vspace|hspace)(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, '')
    .replace(/\\begin\{(abstract|quote)\}([\s\S]*?)\\end\{\1\}/g, (_match, _env, inner) => `\n> ${inner.trim().replace(/\s*\n\s*/g, ' ')}\n`)
    .replace(/\\\\\s*$/gm, '').replace(/~/g, ' ');
  return `${title ? `# ${title}\n\n` : ''}${text.trim()}\n`;
}
