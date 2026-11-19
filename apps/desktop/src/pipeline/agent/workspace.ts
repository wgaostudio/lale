import { fillObligation, parseObligation, type LeanDiagnostic } from '@lale/lean-runner';

// ---------------------------------------------------------------------------
// Agent workspace
//
// What the agent edits: an ordered set of helper files, plus the tactic body of
// the one theorem it was asked to prove. The frozen statement is not in the
// workspace at all — it is spliced in by the harness at composition time, from
// the copy taken before the agent started, so no edit can reach it.
//
// Lean checks one file, so the helper files are concatenated in order ahead of
// the theorem, each wrapped in the claim's helper namespace (`LaleAux.<name>`).
// A namespace or section a file opens it must close; if it does not, the
// harness's closing `end` fails to elaborate, or the theorem lands in the wrong
// namespace and the kernel certificate (which looks it up by its root name)
// fails. That failure is the enforcement; this module only reports it legibly.
// ---------------------------------------------------------------------------

export const MAX_WORKSPACE_FILES = 64;
export const MAX_FILE_BYTES = 200_000;
export const MAX_WORKSPACE_BYTES = 1_000_000;

/** `Growth.lean`, `Capacity/Defect.lean`: capitalised Lean-module-style names only. */
const FILE_PATH = /^[A-Z][A-Za-z0-9_]{0,63}(?:\/[A-Z][A-Za-z0-9_]{0,63}){0,3}\.lean$/;

export function isWorkspacePath(path: string): boolean {
  return FILE_PATH.test(path);
}

export interface FrozenTheorem {
  /** The formalized statement ending `:= by sorry`, with its imports and opens. */
  leanSource: string;
  theoremName: string;
  /** The kernel's rendering of the statement's type, taken when it was frozen. */
  normalizedGoalTerm: string;
}

export interface Segment {
  /** File path, or one of the harness-owned segment labels. */
  label: string;
  /** 1-based first line of the segment in the composed source. */
  startLine: number;
  lineCount: number;
}

export interface Composition {
  source: string;
  segments: Segment[];
}

const IMPORT_LINE = /^\s*import\s+(.+?)\s*$/;

function splitImports(text: string): { imports: string[]; body: string } {
  const imports: string[] = [];
  const bodyLines: string[] = [];
  for (const line of text.split('\n')) {
    const match = IMPORT_LINE.exec(line);
    if (match) imports.push(...match[1]!.split(/\s+/).filter(Boolean));
    else bodyLines.push(line);
  }
  return { imports, body: bodyLines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '') };
}

export class Workspace {
  private readonly files = new Map<string, string>();
  private order: string[] = [];
  private proofBody = '';

  /**
   * Every helper file is wrapped in this namespace. Accepted proofs are stored
   * with their helpers and later composed into other claims' files, so two
   * agents that both wrote `lemma key_bound` would otherwise collide.
   */
  readonly helperNamespace: string;

  constructor(
    readonly frozen: FrozenTheorem,
    /** Accepted declarations this claim may cite; harness-owned. */
    readonly dependencyDeclarations: string,
  ) {
    // Fail at construction, not at the first check, if the header is not a
    // frozen obligation the harness knows how to fill.
    parseObligation(frozen.leanSource, frozen.theoremName);
    this.helperNamespace = helperNamespaceFor(frozen.theoremName);
  }

  get paths(): readonly string[] {
    return this.order;
  }

  get proof(): string {
    return this.proofBody;
  }

  read(path: string): string | undefined {
    return this.files.get(path);
  }

  totalBytes(): number {
    let total = Buffer.byteLength(this.proofBody, 'utf8');
    for (const content of this.files.values()) total += Buffer.byteLength(content, 'utf8');
    return total;
  }

  /** Writes a file. A new file goes at the end, or straight after `after` when given. */
  write(path: string, content: string, after?: string): void {
    if (!isWorkspacePath(path)) {
      throw new Error(`Invalid file path "${path}". Use names like Growth.lean or Capacity/Defect.lean.`);
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes; split it.`);
    const isNew = !this.files.has(path);
    if (isNew && this.order.length >= MAX_WORKSPACE_FILES) throw new Error(`Workspace is limited to ${MAX_WORKSPACE_FILES} files.`);
    const previous = this.files.get(path);
    this.files.set(path, content);
    if (this.totalBytes() > MAX_WORKSPACE_BYTES) {
      if (previous === undefined) this.files.delete(path);
      else this.files.set(path, previous);
      throw new Error(`Workspace would exceed ${MAX_WORKSPACE_BYTES} bytes.`);
    }
    if (isNew) {
      const anchor = after === undefined ? -1 : this.order.indexOf(after);
      if (after !== undefined && anchor < 0) {
        this.files.delete(path);
        throw new Error(`No file "${after}" to place "${path}" after.`);
      }
      if (anchor < 0) this.order.push(path);
      else this.order.splice(anchor + 1, 0, path);
    }
  }

  /** Exact, unique string replacement — cheaper than rewriting a large file. */
  edit(path: string, oldText: string, newText: string): void {
    const current = this.files.get(path);
    if (current === undefined) throw new Error(`No file "${path}".`);
    if (!oldText) throw new Error('old_text must be non-empty.');
    const first = current.indexOf(oldText);
    if (first < 0) throw new Error(`old_text not found in ${path}.`);
    if (current.indexOf(oldText, first + 1) >= 0) throw new Error(`old_text occurs more than once in ${path}; include more context.`);
    this.write(path, current.slice(0, first) + newText + current.slice(first + oldText.length));
  }

  delete(path: string): void {
    if (!this.files.delete(path)) throw new Error(`No file "${path}".`);
    this.order = this.order.filter((p) => p !== path);
  }

  /** Replaces the file order. Must name every file exactly once. */
  reorder(paths: string[]): void {
    const unique = new Set(paths);
    if (unique.size !== paths.length || unique.size !== this.order.length || paths.some((p) => !this.files.has(p))) {
      throw new Error(`Order must list each existing file exactly once: ${this.order.join(', ') || '(none)'}`);
    }
    this.order = [...paths];
  }

  setProof(body: string): void {
    if (!body.trim()) throw new Error('Proof body is empty.');
    if (Buffer.byteLength(body, 'utf8') > MAX_FILE_BYTES) throw new Error(`Proof body exceeds ${MAX_FILE_BYTES} bytes.`);
    this.proofBody = body;
  }

  /**
   * One Lean source: hoisted imports, dependencies, helper files in order, and
   * then — unless `upTo` stops earlier — the frozen theorem, filled with the
   * agent's proof (or `sorry` if none is set yet). `suffix` is appended after
   * the helper files in place of the theorem, for probes.
   */
  compose(options: { upTo?: string; suffix?: string; includeTheorem?: boolean; includeDependencies?: boolean } = {}): Composition {
    const includeTheorem = options.includeTheorem ?? (options.upTo === undefined && options.suffix === undefined);
    let paths = this.order;
    if (options.upTo !== undefined) {
      const index = this.order.indexOf(options.upTo);
      if (index < 0) throw new Error(`No file "${options.upTo}".`);
      paths = this.order.slice(0, index + 1);
    }

    const header = splitImports(this.frozen.leanSource);
    const deps = splitImports(this.dependencyDeclarations);
    const parts: Array<{ label: string; text: string; wrap?: string }> = [];
    const imports = new Set<string>([...header.imports, ...deps.imports]);
    if (deps.body && options.includeDependencies !== false) parts.push({ label: '<dependencies>', text: deps.body });
    for (const path of paths) {
      const file = splitImports(this.files.get(path)!);
      for (const module of file.imports) imports.add(module);
      parts.push({ label: path, text: file.body, wrap: this.helperNamespace });
    }
    if (options.suffix !== undefined) parts.push({ label: '<probe>', text: options.suffix.replace(/\s+$/, '') });
    if (includeTheorem) {
      const filled = this.proofBody.trim()
        ? fillObligation(header.body, this.proofBody, this.frozen.theoremName)
        : header.body;
      parts.push({ label: '<theorem>', text: filled.replace(/\s+$/, '') });
    }

    const lines: string[] = [];
    const segments: Segment[] = [];
    if (imports.size) {
      segments.push({ label: '<imports>', startLine: 1, lineCount: imports.size });
      for (const module of imports) lines.push(`import ${module}`);
    }
    for (const part of parts) {
      lines.push('');
      if (part.wrap) lines.push(`namespace ${part.wrap}`);
      const partLines = part.text ? part.text.split('\n') : [];
      segments.push({ label: part.label, startLine: lines.length + 1, lineCount: partLines.length });
      lines.push(...partLines);
      if (part.wrap) lines.push(`end ${part.wrap}`);
    }
    return { source: `${lines.join('\n')}\n`, segments };
  }

  /**
   * What gets stored as the accepted proof: helpers and the filled theorem,
   * without the dependencies (stored separately, as for the one-shot proposer).
   * A later claim citing this one needs the helpers too, or it will not compile.
   */
  acceptedSource(): string {
    return this.compose({ includeTheorem: true, includeDependencies: false }).source;
  }
}

/** `LaleAux.<theorem>`: theorem names are simple identifiers, so this is a valid namespace. */
export function helperNamespaceFor(theoremName: string): string {
  return `LaleAux.${theoremName}`;
}

/** Maps a composed-source line back to `File.lean:line`. */
export function locate(segments: Segment[], line: number | undefined): string {
  if (line === undefined) return '';
  for (const segment of segments) {
    if (line >= segment.startLine && line < segment.startLine + Math.max(1, segment.lineCount)) {
      return `${segment.label}:${line - segment.startLine + 1}`;
    }
  }
  return `line ${line}`;
}

const MAX_DIAGNOSTIC_CHARS = 1500;
const MAX_DIAGNOSTICS = 20;

/** Diagnostics as the agent sees them: located, deduplicated, trimmed. */
export function formatDiagnostics(diagnostics: LeanDiagnostic[], segments: Segment[]): string {
  if (diagnostics.length === 0) return '(no diagnostics)';
  const ordered = [...diagnostics].sort((a, b) => rank(a.kind) - rank(b.kind));
  const shown = ordered.slice(0, MAX_DIAGNOSTICS).map((d) => {
    const where = locate(segments, d.line);
    const message = d.message.length > MAX_DIAGNOSTIC_CHARS ? `${d.message.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : d.message;
    return `${d.kind}${where ? ` ${where}` : ''}: ${message}`;
  });
  if (ordered.length > MAX_DIAGNOSTICS) shown.push(`… ${ordered.length - MAX_DIAGNOSTICS} more`);
  return shown.join('\n\n');
}

function rank(kind: LeanDiagnostic['kind']): number {
  return kind === 'error' ? 0 : kind === 'warning' ? 1 : 2;
}
