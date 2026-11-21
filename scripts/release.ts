#!/usr/bin/env tsx
// Release helper for esa-dono-ui.
//
// Two modes:
//
//   npm run release -- --check              consistency check (CI on every PR)
//   npm run release -- --check --expect-release
//                                           release gate (CI on PRs to main)
//   npm run release -- [x.y.z] [--force]    prepare a release: bump every version
//                                           field and turn `## [Unreleased]` into
//                                           a dated `## [x.y.z]` section
//
// Version fields kept in lockstep: root/server/client/packages.shared
// package.json, package-lock.json (root and workspace entries only — third-party
// dependencies may themselves sit at the same version string), and
// server/openapi.yaml info.version. The CI tag-version job reads the root
// manifest, so a drifted copy would tag images with a version the code does not
// claim; --check refuses that state.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');
const UNRELEASED_HEADING = '## [Unreleased]';

// ---------- semver (bare x.y.z) ----------

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function parseSemVer(text: string): SemVer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [, major, minor, patch] = m;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function cmpSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function bumpSemVer(v: SemVer, kind: 'minor' | 'patch'): SemVer {
  return kind === 'minor'
    ? { major: v.major, minor: v.minor + 1, patch: 0 }
    : { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

// ---------- version locations ----------

interface VersionLocation {
  label: string;
  read(): string;
  write(version: string): void;
}

function readJsonFile(rel: string): Record<string, unknown> {
  const data: unknown = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  if (typeof data !== 'object' || data === null) {
    throw new Error(`${rel}: expected a JSON object`);
  }
  return data as Record<string, unknown>;
}

function writeJsonFile(rel: string, data: Record<string, unknown>): void {
  writeFileSync(join(ROOT, rel), `${JSON.stringify(data, null, 2)}\n`);
}

function readVersionField(data: Record<string, unknown>, rel: string): string {
  const v = data.version;
  if (typeof v !== 'string') throw new Error(`${rel}: missing "version" field`);
  return v;
}

function manifestLocation(rel: string): VersionLocation {
  return {
    label: rel,
    read: () => readVersionField(readJsonFile(rel), rel),
    write(version) {
      const data = readJsonFile(rel);
      data.version = version;
      writeJsonFile(rel, data);
    },
  };
}

function lockfileLocation(): VersionLocation {
  const rel = 'package-lock.json';
  return {
    label: rel,
    read: () => readVersionField(readJsonFile(rel), rel),
    write(version) {
      const data = readJsonFile(rel);
      data.version = version;
      const packages = data.packages;
      if (typeof packages !== 'object' || packages === null) {
        throw new Error(`${rel}: missing "packages"`);
      }
      // Only root ("") and workspace entries. Third-party packages can carry the
      // same version string (e.g. asynckit@0.4.0) and must never be touched.
      for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
        const isWorkspace =
          key !== '' &&
          !key.startsWith('node_modules/') &&
          existsSync(join(ROOT, key, 'package.json'));
        if (key !== '' && !isWorkspace) continue;
        if (typeof value !== 'object' || value === null) continue;
        (value as Record<string, unknown>).version = version;
      }
      writeJsonFile(rel, data);
    },
  };
}

function openapiLocation(): VersionLocation {
  const rel = 'server/openapi.yaml';
  const pattern = /^( {2})version: '([^']+)'$/m;
  return {
    label: `${rel} info.version`,
    read() {
      const m = pattern.exec(readFileSync(join(ROOT, rel), 'utf8'));
      const version = m?.[2];
      if (version === undefined) throw new Error(`${rel}: no info.version line`);
      return version;
    },
    write(version) {
      const raw = readFileSync(join(ROOT, rel), 'utf8');
      if (!pattern.test(raw)) throw new Error(`${rel}: no info.version line`);
      writeFileSync(join(ROOT, rel), raw.replace(pattern, `$1version: '${version}'`));
    },
  };
}

function locations(): VersionLocation[] {
  return [
    manifestLocation('package.json'),
    manifestLocation('server/package.json'),
    manifestLocation('client/package.json'),
    manifestLocation('packages/shared/package.json'),
    lockfileLocation(),
    openapiLocation(),
  ];
}

// ---------- changelog ----------

interface VersionSection {
  version: string;
  date: string | null;
  headingIndex: number;
}

const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\](?:\s+[\u2014-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

function sectionBody(lines: string[], headingIndex: number): string[] {
  const body: string[] = [];
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ')) break;
    body.push(line);
  }
  return body;
}

function hasBullets(body: string[]): boolean {
  return body.some((line) => /^\s*[-*]\s+/.test(line));
}

function parseChangelog(): {
  lines: string[];
  sections: VersionSection[];
  unreleasedIndex: number;
} {
  const lines = readFileSync(CHANGELOG_PATH, 'utf8').split('\n');
  const sections: VersionSection[] = [];
  lines.forEach((line, headingIndex) => {
    const m = VERSION_HEADING.exec(line);
    if (m?.[1] !== undefined) {
      sections.push({ version: m[1], date: m[2] ?? null, headingIndex });
    }
  });
  const unreleasedIndex = lines.findIndex((line) => line.trim() === UNRELEASED_HEADING);
  return { lines, sections, unreleasedIndex };
}

// ---------- git ----------

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function releaseTags(): Array<{ text: string; version: SemVer }> {
  return git('tag', '--list')
    .split('\n')
    .map((text) => ({ text, version: parseSemVer(text) }))
    .filter((entry): entry is { text: string; version: SemVer } => entry.version !== null)
    .sort((a, b) => cmpSemVer(a.version, b.version));
}

// ---------- check mode ----------

function collectErrors(expectRelease: boolean): string[] {
  const errors: string[] = [];

  const found: Array<{ label: string; version: string }> = [];
  for (const loc of locations()) {
    try {
      found.push({ label: loc.label, version: loc.read() });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const distinct = new Set(found.map((entry) => entry.version));
  if (distinct.size > 1) {
    errors.push(
      `version fields disagree:\n${found.map((entry) => `  ${entry.label}: ${entry.version}`).join('\n')}`,
    );
  }
  const versionText = found[0]?.version ?? '';
  const version = parseSemVer(versionText);
  if (!version) {
    errors.push(`version "${versionText}" is not bare x.y.z semver`);
    return errors;
  }

  const tags = releaseTags();
  const latest = tags.at(-1);
  if (!latest) {
    errors.push('no bare x.y.z release tags found');
    return errors;
  }
  const cmp = cmpSemVer(version, latest.version);
  if (expectRelease && cmp <= 0) {
    errors.push(`version ${versionText} must be greater than the latest tag ${latest.text}`);
  } else if (!expectRelease && cmp < 0) {
    errors.push(`version ${versionText} is behind the latest tag ${latest.text}`);
  }

  const { lines, sections, unreleasedIndex } = parseChangelog();
  if (unreleasedIndex < 0) {
    errors.push(`CHANGELOG.md has no "${UNRELEASED_HEADING}" section`);
  } else if (expectRelease && hasBullets(sectionBody(lines, unreleasedIndex))) {
    errors.push(
      `${UNRELEASED_HEADING} still has bullet points; the release section must carry them`,
    );
  }

  const section = sections.find((entry) => entry.version === versionText);
  if (!section) {
    errors.push(`CHANGELOG.md has no "## [${versionText}]" section`);
  } else {
    if (section.date === null) {
      errors.push(`CHANGELOG.md "## [${versionText}]" is missing its "— YYYY-MM-DD" date`);
    }
    if (sectionBody(lines, section.headingIndex).join('').trim() === '') {
      errors.push(`CHANGELOG.md "## [${versionText}]" has an empty body`);
    }
    if (expectRelease && !hasBullets(sectionBody(lines, section.headingIndex))) {
      errors.push(`CHANGELOG.md "## [${versionText}]" has no bullet points`);
    }
  }

  return errors;
}

// ---------- prepare mode ----------

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prepare(versionArg: string | undefined, force: boolean): void {
  const tags = releaseTags();
  const latest = tags.at(-1);
  if (!latest) throw new Error('no bare x.y.z release tags found');

  const rootVersion = locations()[0]?.read() ?? '';
  const base = parseSemVer(rootVersion);
  if (!base) throw new Error(`root version "${rootVersion}" is not bare x.y.z semver`);

  const subjects = git('log', `${latest.text}..HEAD`, '--pretty=%s')
    .split('\n')
    .filter((line) => line.trim() !== '');
  if (subjects.length === 0) throw new Error(`no commits since ${latest.text}; nothing to release`);
  const suggested: 'minor' | 'patch' = subjects.some(
    (s) => /^feat(\(|:|!)/i.test(s) || /^breaking/i.test(s) || s.includes('!:'),
  )
    ? 'minor'
    : 'patch';

  const target = versionArg ? parseSemVer(versionArg) : bumpSemVer(base, suggested);
  if (!target) throw new Error(`"${versionArg}" is not bare x.y.z semver`);
  if (cmpSemVer(target, base) <= 0) {
    throw new Error(
      `${formatSemVer(target)} is not greater than the current ${formatSemVer(base)}`,
    );
  }
  const suggestedTarget = bumpSemVer(base, suggested);
  if (!force && cmpSemVer(target, suggestedTarget) < 0) {
    throw new Error(
      `commits since ${latest.text} suggest at least ${formatSemVer(suggestedTarget)} (${suggested}); ` +
        `pass --force to release ${formatSemVer(target)} anyway`,
    );
  }

  const { lines, unreleasedIndex } = parseChangelog();
  if (unreleasedIndex < 0) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" section`);
  if (!hasBullets(sectionBody(lines, unreleasedIndex))) {
    throw new Error(`${UNRELEASED_HEADING} has no bullet points; add release notes first`);
  }

  const targetText = formatSemVer(target);
  for (const loc of locations()) loc.write(targetText);
  lines.splice(unreleasedIndex + 1, 0, '', `## [${targetText}] \u2014 ${today()}`);
  writeFileSync(CHANGELOG_PATH, lines.join('\n'));

  const errors = collectErrors(true);
  if (errors.length > 0) {
    throw new Error(`release prepared but verification failed:\n${errors.join('\n')}`);
  }

  console.log(`Prepared ${targetText} (${suggested} bump over ${latest.text}).`);
  console.log(
    'Updated: ' +
      locations()
        .map((loc) => loc.label)
        .join(', ') +
      ', CHANGELOG.md',
  );
  console.log(
    `Next: commit these files on chore/release-${targetText}, merge it to dev, then open the dev -> main gate PR.`,
  );
}

// ---------- entry ----------

function main(): void {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const expectRelease = args.includes('--expect-release');
  const force = args.includes('--force');
  const positional = args.filter((arg) => !arg.startsWith('--'));

  if (check) {
    const errors = collectErrors(expectRelease);
    if (errors.length > 0) {
      for (const error of errors) console.error(`error: ${error}`);
      process.exit(1);
    }
    const mode = expectRelease ? 'release gate' : 'consistency';
    console.log(`${mode} check passed.`);
    return;
  }

  const version = positional[0];
  if (positional.length > 1) {
    console.error('usage: npm run release [-- x.y.z] [--force] | --check [--expect-release]');
    process.exit(1);
  }
  try {
    prepare(version, force);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
