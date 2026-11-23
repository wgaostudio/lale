import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLatexDocument } from '@lale/document-parser';
import { buildAuditGraph, selectReachableContext } from '../src/pipeline/context.js';

const document = String.raw`\begin{document}
Let $n$ be a positive integer.
\section{First}
\begin{lemma}\label{lem:a} $n + 0 = n$.\end{lemma}
\begin{proof}By addition.\end{proof}
\section{Second}
\begin{theorem}\label{thm:b} By \ref{lem:a}, $n + 0 = n$.\end{theorem}
\end{document}`;

test('ambient hypothesis edits invalidate claims and dependency fingerprints', () => {
  const before = parseLatexDocument(document);
  const after = parseLatexDocument(document.replace('positive integer', 'real number'));
  assert.equal(before.claims[0]!.statement, after.claims[0]!.statement);
  for (let i = 0; i < before.claims.length; i++) {
    assert.notEqual(before.claims[i]!.fingerprint, after.claims[i]!.fingerprint);
  }
  const context = (doc: typeof before) => selectReachableContext(buildAuditGraph(doc), 'thm:b', doc);
  assert.notEqual(context(before).resolvedDependencies[0]!.fingerprint,
    context(after).resolvedDependencies[0]!.fingerprint);
});

test('an unrelated later section does not invalidate earlier claims', () => {
  const before = parseLatexDocument(document);
  const after = parseLatexDocument(document.replace('\\section{Second}', '\\section{Second}\nLet $x$ be real.'));
  assert.equal(before.claims[0]!.fingerprint, after.claims[0]!.fingerprint);
  assert.notEqual(before.claims[1]!.fingerprint, after.claims[1]!.fingerprint);
});

test('comments do not change a claim fingerprint', () => {
  const before = parseLatexDocument(document);
  const after = parseLatexDocument(document.replace('positive integer.', 'positive integer. % explanation'));
  assert.equal(before.claims[0]!.fingerprint, after.claims[0]!.fingerprint);
});

test('in an unsectioned paper, definitions just before a claim survive long front matter', () => {
  const frontMatter = Array.from({ length: 200 }, (_, i) => `Front matter line ${i} about the history of the problem.`).join('\n');
  const paper = String.raw`\begin{document}
\maketitle
\begingroup\renewcommand{\thefootnote}{}\footnotetext{MSC 16D90.}\endgroup
\noindent ${frontMatter}
Let $K(X)$ be the field of rational functions in indeterminates $x_{i,j}$.
\begin{lemma}\label{lem:one} The elements $c_i$ are independent over $K(X)$.\end{lemma}
\end{document}`;
  const ambient = parseLatexDocument(paper).claims[0]!.ambientContext;
  assert.match(ambient, /Let \$K\(X\)\$ be the field of rational functions/, 'the nearest definition is kept');
  assert.match(ambient, /Front matter line 0 /, 'the opening is kept too');
  assert.match(ambient, /\[…\]/, 'and the cut is marked');
  assert.doesNotMatch(ambient, /maketitle|footnotetext|noindent|begingroup/, 'layout commands are dropped');
});

test('isolateScopes keeps imports at the top and wraps the rest', async () => {
  const { isolateScopes } = await import('../src/pipeline/lean-scope.js');
  assert.equal(isolateScopes('import Mathlib\nopen DirectSum\ntheorem t : True := trivial'),
    'import Mathlib\nsection\nopen DirectSum\ntheorem t : True := trivial\nend');
  assert.equal(isolateScopes('import Mathlib\n'), 'import Mathlib');
});
