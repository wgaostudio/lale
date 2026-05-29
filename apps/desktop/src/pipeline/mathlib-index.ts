import { constants, type Dirent } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const MAX_IMPORT_HINTS = 12;

export type MathlibImportStatus = 'valid' | 'invalid' | 'missingOlean' | 'ignored';

export interface MathlibImportValidation {
  moduleName: string;
  status: MathlibImportStatus;
  candidates: string[];
}

export interface MathlibImportIndex {
  projectDir: string;
  mathlibRevision: string;
  moduleCount: number;
  oleanCount: number;
  validateImport(moduleName: string): MathlibImportValidation;
}

export interface MathlibImportRepair {
  moduleName: string;
  replacements: string[];
}

const indexCache = new Map<string, Promise<MathlibImportIndex | null>>();

export function clearMathlibImportIndexCache(): void {
  indexCache.clear();
}

export async function getMathlibImportIndex(
  projectDir: string,
  mathlibRevision: string,
): Promise<MathlibImportIndex | null> {
  const key = `${projectDir}\0${mathlibRevision}`;
  const cached = indexCache.get(key);
  if (cached) return cached;

  const pending = buildMathlibImportIndex(projectDir, mathlibRevision)
    .catch(() => null)
    .then((index) => {
      if (index === null) indexCache.delete(key);
      return index;
    });

  indexCache.set(key, pending);
  return pending;
}

export function extractLeanImports(source: string): string[] {
  const imports: string[] = [];

  for (const line of source.split('\n')) {
    const parsed = parseImportLine(line);
    if (!parsed) continue;
    imports.push(...parsed.modules);
  }

  return imports;
}

export function replaceInvalidMathlibImports(
  source: string,
  repairs: Iterable<MathlibImportRepair>,
): string {
  const repairMap = new Map<string, string[]>();
  for (const repair of repairs) {
    repairMap.set(repair.moduleName, repair.replacements.length > 0 ? repair.replacements : ['Mathlib']);
  }
  if (repairMap.size === 0) return source;

  const lines = source.split('\n');
  const output: string[] = [];
  let changed = false;
  const emittedImports = new Set<string>();

  for (const line of lines) {
    const parsed = parseImportLine(line);
    if (!parsed) {
      output.push(line);
      continue;
    }

    const keptModules: string[] = [];
    for (const moduleName of parsed.modules) {
      const replacements = repairMap.get(moduleName) ?? [moduleName];
      if (replacements.length !== 1 || replacements[0] !== moduleName) changed = true;

      for (const replacement of replacements) {
        if (emittedImports.has(replacement)) continue;
        emittedImports.add(replacement);
        keptModules.push(replacement);
      }
    }

    for (const moduleName of keptModules) {
      output.push(`${parsed.indent}import ${moduleName}`);
    }
  }

  if (!changed) return source;
  return output.join('\n');
}

function isMathlibModule(moduleName: string): boolean {
  return moduleName === 'Mathlib' || moduleName.startsWith('Mathlib.');
}

async function buildMathlibImportIndex(
  projectDir: string,
  mathlibRevision: string,
): Promise<MathlibImportIndex | null> {
  const mathlibRoot = join(projectDir, '.lake', 'packages', 'mathlib');
  await access(mathlibRoot, constants.R_OK);

  const sourceModules = new Set<string>();
  const oleanModules = new Set<string>();

  await addIfReadable(join(mathlibRoot, 'Mathlib.lean'), sourceModules, 'Mathlib');
  await scanModules(join(mathlibRoot, 'Mathlib'), mathlibRoot, '.lean', sourceModules);

  const oleanRoot = join(mathlibRoot, '.lake', 'build', 'lib', 'lean');
  await addIfReadable(join(oleanRoot, 'Mathlib.olean'), oleanModules, 'Mathlib');
  await scanModules(join(oleanRoot, 'Mathlib'), oleanRoot, '.olean', oleanModules);

  if (sourceModules.size === 0) return null;

  const moduleNames = [...sourceModules].sort();
  const importableModules = moduleNames.filter((moduleName) => oleanModules.has(moduleName));
  const candidateModules = importableModules.length > 0 ? importableModules : moduleNames;

  return {
    projectDir,
    mathlibRevision,
    moduleCount: sourceModules.size,
    oleanCount: oleanModules.size,
    validateImport(moduleName: string): MathlibImportValidation {
      if (!isMathlibModule(moduleName)) {
        return { moduleName, status: 'ignored', candidates: [] };
      }

      if (!sourceModules.has(moduleName)) {
        return {
          moduleName,
          status: 'invalid',
          candidates: nearbyCandidates(moduleName, candidateModules, MAX_IMPORT_HINTS),
        };
      }

      if (!oleanModules.has(moduleName)) {
        return { moduleName, status: 'missingOlean', candidates: [] };
      }

      return { moduleName, status: 'valid', candidates: [] };
    },
  };
}

async function addIfReadable(path: string, modules: Set<string>, moduleName: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
    modules.add(moduleName);
  } catch {
    // Missing root modules are handled by the caller's empty-index fallback.
  }
}

async function scanModules(
  dir: string,
  root: string,
  extension: '.lean' | '.olean',
  modules: Set<string>,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanModules(path, root, extension, modules);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
    const rel = relative(root, path).split(sep).join('/');
    modules.add(rel.slice(0, -extension.length).replace(/\//g, '.'));
  }
}

function nearbyCandidates(
  requestedModule: string,
  modules: readonly string[],
  limit: number,
): string[] {
  const directPrefix = `${requestedModule}.`;
  const directChildren = modules.filter((moduleName) => moduleName.startsWith(directPrefix));
  if (directChildren.length > 0) {
    return directChildren.sort(compareCandidate(requestedModule)).slice(0, limit);
  }

  const requestedParts = requestedModule.split('.');
  for (let depth = requestedParts.length - 1; depth >= 1; depth--) {
    const parent = requestedParts.slice(0, depth).join('.');
    const parentPrefix = `${parent}.`;
    const siblings = modules.filter(
      (moduleName) => moduleName !== parent && moduleName.startsWith(parentPrefix),
    );
    if (siblings.length > 0) {
      return siblings.sort(compareCandidate(requestedModule)).slice(0, limit);
    }
  }

  return [];
}

function compareCandidate(requestedModule: string): (a: string, b: string) => number {
  const requestedDepth = requestedModule.split('.').length;
  return (a, b) => {
    const commonDelta = commonPrefixDepth(b, requestedModule) - commonPrefixDepth(a, requestedModule);
    if (commonDelta !== 0) return commonDelta;

    const aDepthDelta = Math.abs(a.split('.').length - requestedDepth);
    const bDepthDelta = Math.abs(b.split('.').length - requestedDepth);
    if (aDepthDelta !== bDepthDelta) return aDepthDelta - bDepthDelta;

    return a.localeCompare(b);
  };
}

function commonPrefixDepth(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const limit = Math.min(aParts.length, bParts.length);
  let depth = 0;

  while (depth < limit && aParts[depth] === bParts[depth]) depth++;
  return depth;
}

function parseImportLine(line: string): { indent: string; modules: string[] } | null {
  const match = /^(\s*)import\s+(.+)$/.exec(line);
  if (!match) return null;

  const rest = (match[2] ?? '').split('--')[0]?.trim() ?? '';
  if (!rest) return null;

  return {
    indent: match[1] ?? '',
    modules: rest.split(/\s+/).filter(Boolean),
  };
}
