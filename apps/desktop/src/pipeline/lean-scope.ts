// ---------------------------------------------------------------------------
// Scope isolation for concatenated Lean sources
//
// lale builds one Lean file out of many sources: definitions and claims the
// target cites, cited-result definitions, the author's proved steps, then the
// target. Each source may open namespaces for itself (`open DirectSum`,
// `open scoped Classical`), and at the top level of a file an `open` lasts
// until the end of it. One source's opens then change how every later
// statement elaborates. The kernel gate caught this (soundness held) but it
// rejected correct proofs: in a live run on Smoktunowicz's Lemma 3, a proved
// step's opens reached the later steps, whose statements had been frozen
// without them, and three complete proofs were turned away as "a different
// proposition".
//
// Wrapping each source's body in an anonymous `section ... end` ends its
// opens (and any other scoped settings) with it. Imports stay outside, since
// Lean requires them at the top of the file; `composeLeanFile` hoists them.
// ---------------------------------------------------------------------------

const IMPORT_LINE = /^\s*import\s/;

export function isolateScopes(source: string): string {
  const lines = source.split('\n');
  const imports = lines.filter((line) => IMPORT_LINE.test(line));
  const body = lines.filter((line) => !IMPORT_LINE.test(line)).join('\n').trim();
  if (!body) return imports.join('\n');
  return [...imports, 'section', body, 'end'].join('\n');
}
