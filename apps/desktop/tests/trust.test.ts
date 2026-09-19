import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fillObligation,
  parseObligation,
  sameObligation,
  scanTrustViolations,
  stripLeanCommentsAndStrings,
} from '@lale/lean-runner';

// The trust scanner and the obligation parser are the boundary between model
// output and Lean's kernel: everything past them is compiled. Nothing here
// needs a Lean toolchain — these are the pure functions that decide what gets
// to run at all.

const names = (source: string): string[] => scanTrustViolations(source).map((v) => v.name).sort();

test('the trust scanner rejects every escape hatch that would fake a proof', () => {
  assert.deepEqual(names('theorem t : True := by trivial'), []);

  for (const [source, expected] of [
    ['theorem t : True := by sorry', 'sorry'],
    ['theorem t : True := by admit', 'admit'],
    ['axiom bad : False', 'custom-axiom'],
    ['opaque bad : Nat', 'opaque'],
    ['unsafe def bad : Nat := 0', 'unsafe'],
    ['theorem t : True := by native_decide', 'native_decide'],
    ['def f : IO Unit := pure ()', 'IO'],
    ['run_cmd pure ()', 'metaprogramming'],
    ['theorem «odd name» : True := by trivial', 'quoted-identifiers'],
    ['set_option maxHeartbeats 0 in\ntheorem t : True := by trivial', 'commands'],
  ] as const) {
    assert.ok(
      names(source).includes(expected),
      `expected ${expected} from ${JSON.stringify(source)}, got ${JSON.stringify(names(source))}`,
    );
  }
});

test('the scanner reads code, not prose: comments and strings are not declarations', () => {
  // A paper's proof text routinely contains the word "sorry"; quoting it in a
  // comment must not block the run.
  assert.deepEqual(names('-- the author says sorry here\ntheorem t : True := by trivial'), []);
  assert.deepEqual(names('/- sorry -/ theorem t : True := by trivial'), []);
  assert.deepEqual(names('/- outer /- sorry -/ still -/ theorem t : True := by trivial'), []);

  // ...but the same word as an actual tactic still is.
  assert.deepEqual(names('-- comment\ntheorem t : True := by sorry'), ['sorry']);
});

test('an unterminated comment or string fails closed rather than scanning half a file', () => {
  assert.throws(() => stripLeanCommentsAndStrings('/- never closed'), /Unterminated Lean comment/);
  assert.throws(() => stripLeanCommentsAndStrings('def s := "never closed'), /Unterminated Lean string/);
  // scanTrustViolations is total, so callers see a blocked check, not a crash.
  assert.throws(() => scanTrustViolations('/- never closed'));
});

test('stripping preserves offsets so diagnostics still line up', () => {
  const source = 'import Mathlib\n-- a comment\ntheorem t : True := by trivial';
  const stripped = stripLeanCommentsAndStrings(source);
  assert.equal(stripped.length, source.length);
  assert.equal(stripped.split('\n').length, source.split('\n').length);
});

const OBLIGATION = 'import Mathlib\n\ntheorem addZero : ∀ (n : Nat), n + 0 = n := by sorry';

test('the obligation parser accepts one closed proposition and nothing else', () => {
  const obligation = parseObligation(OBLIGATION, 'addZero');
  assert.equal(obligation.name, 'addZero');
  assert.equal(obligation.proposition, '∀ (n : Nat), n + 0 = n');
  assert.equal(obligation.proofBody, 'sorry');
  assert.match(obligation.header, /theorem addZero .* := by$/);

  // A name that does not match its metadata is a different theorem.
  assert.throws(() => parseObligation(OBLIGATION, 'somethingElse'), /does not match/);
});

test('the obligation parser refuses shapes that would let the statement move', () => {
  const cases: Array<[string, RegExp]> = [
    // Two theorems: which one was frozen?
    ['theorem a : True := by sorry\ntheorem b : True := by sorry', /Expected one theorem/],
    // No theorem at all.
    ['def f : Nat := 0', /Expected one theorem/],
    // Declaration binders put hypotheses outside the proposition, where a
    // proof could quietly be given a stronger environment.
    ['variable (n : Nat)\ntheorem t : n = n := by sorry', /preamble may contain only/],
    // A helper declaration in the preamble is extra trusted surface.
    ['def helper : Nat := 0\ntheorem t : True := by sorry', /preamble may contain only/],
    // Term-mode proofs bypass the `by` block the proposer is allowed to fill.
    ['theorem t : True := trivial', /Expected := by/],
  ];
  for (const [source, expected] of cases) {
    assert.throws(() => parseObligation(source), expected, `expected ${expected} for ${source}`);
  }
});

test('filling an obligation changes the proof and only the proof', () => {
  const filled = fillObligation(OBLIGATION, 'intro n\nsimp', 'addZero');
  assert.match(filled, /theorem addZero : ∀ \(n : Nat\), n \+ 0 = n := by\n {2}intro n\n {2}simp/);
  assert.equal(parseObligation(filled, 'addZero').proposition, parseObligation(OBLIGATION, 'addZero').proposition);
  assert.ok(sameObligation(OBLIGATION, filled, 'addZero'));

  assert.throws(() => fillObligation(OBLIGATION, '   ', 'addZero'), /Empty proof body/);
});

test('sameObligation is what stops a proof from rewriting the theorem it proves', () => {
  const weakened = 'import Mathlib\n\ntheorem addZero : ∀ (n : Nat), n + 0 = n ∨ True := by trivial';
  assert.equal(sameObligation(OBLIGATION, weakened, 'addZero'), false);

  const extraImport = 'import Mathlib\nimport Std\n\ntheorem addZero : ∀ (n : Nat), n + 0 = n := by trivial';
  assert.equal(sameObligation(OBLIGATION, extraImport, 'addZero'), false);

  // Unparseable input is not "the same" by default.
  assert.equal(sameObligation(OBLIGATION, 'not lean at all', 'addZero'), false);
});
