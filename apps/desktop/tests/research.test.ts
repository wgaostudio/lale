import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECK_ORDER, EDITS, prepareTestCopy } from '../src/research/smoktunowicz.js';

// The paper is not in the repository, so the transform is tested on a
// stand-in made of its anchors: every edit must apply exactly once, and a
// source that differs must fail rather than yield a quietly different test.

const standIn = EDITS.map((e) => e.find).join('\n\n%%\n\n');

test('every edit applies exactly once to a source that has its anchors', () => {
  const out = prepareTestCopy(standIn.replace(/\n/g, '\r\n'));
  for (const label of ['thm:main', 'thm:as', 'lem:1', 'lem:2', 'lem:3', 'thm:3', 'def:gk', 'def:fg', 'def:q']) {
    assert.equal(out.split(`\\label{${label}}`).length - 1, 1, label);
  }
  assert.ok(!out.includes('Proof of Theorem 1.'), 'the detached proof is removed');
  assert.match(out, /\\begin\{proof\}\nIt follows from Theorem~\\ref\{thm:as\}/);
  assert.ok(!/\bLemma [123]\b/.test(out.replace(/Lemma~\\ref/g, '')), 'no textual lemma references remain');
});

test('a source that differs fails loudly', () => {
  assert.throws(() => prepareTestCopy(standIn.replace('By Lemma 2, there are', 'By Lemma two, there are')), /anchor not found.*Lemma 2/);
  assert.throws(() => prepareTestCopy(`${standIn}\n${EDITS[7]!.find}`), /ambiguous/);
  assert.throws(() => prepareTestCopy(prepareTestCopy(standIn)), /anchor not found/, 'not idempotent by accident');
});

test('the check order puts every claim after what it cites', () => {
  const position = new Map(CHECK_ORDER.map((label, i) => [label, i] as const));
  const out = prepareTestCopy(standIn);
  for (const label of CHECK_ORDER) {
    const at = out.indexOf(`\\label{${label}}`);
    const next = out.indexOf('\\label{', at + 1);
    const block = out.slice(at, next < 0 ? undefined : next);
    for (const ref of block.matchAll(/\\ref\{([^}]+)\}/g)) {
      if (ref[1] === label) continue;
      assert.ok(position.get(ref[1] as (typeof CHECK_ORDER)[number])! < position.get(label)!, `${label} cites ${ref[1]}`);
    }
  }
});
