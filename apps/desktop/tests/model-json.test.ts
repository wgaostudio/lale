import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelJson, repairJsonEscapes } from '@lale/translator';

test('LaTeX in a model explanation no longer fails the parse (first live run)', () => {
  // The reply that stopped a run as verificationBlocked, verbatim.
  const reply = String.raw`{
  "agreement": "agree",
  "explanation": "Both statements assert that for any even integers \(a\) and \(b\), their sum is even."
}`;
  const parsed = parseModelJson(reply);
  assert.equal(parsed['agreement'], 'agree');
  assert.equal(parsed['explanation'], String.raw`Both statements assert that for any even integers \(a\) and \(b\), their sum is even.`);
});

test('repair leaves valid escapes alone and fixes only invalid ones', () => {
  assert.equal(repairJsonEscapes(String.raw`"a\nb \"q\" \\( é \( \u00zz"`), String.raw`"a\nb \"q\" \\( é \\( \\u00zz"`);
  assert.deepEqual(parseModelJson('```json\n{"x": "\\(1\\)"}\n```'), { x: '\\(1\\)' });
  assert.deepEqual(parseModelJson('Sure: {"ok": true} hope that helps'), { ok: true });
  assert.deepEqual(parseModelJson('{"leanSource": "import Mathlib\\ntheorem t : True := trivial"}'),
    { leanSource: 'import Mathlib\ntheorem t : True := trivial' }, 'a well-formed reply is not rewritten');
  assert.throws(() => parseModelJson('no json here'), /non-JSON/);
});
