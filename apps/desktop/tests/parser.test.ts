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
