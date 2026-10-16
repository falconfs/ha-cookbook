import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Bump = 'patch' | 'minor' | 'major';
type JsonObject = Record<string, unknown>;
export interface Commit { hash: string; message: string }
interface CommandOptions { cwd: string; env: NodeJS.ProcessEnv; input?: string }
export type Command = (command: string, args: readonly string[], options: CommandOptions) => Promise<string>;
export interface ReleaseOptions {
  mode: 'preview' | 'publish';
  resume?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execute?: Command;
  log?: (message: string) => void;
}
interface Context {
  git: (...args: string[]) => Promise<string>;
  command: (file: string, args: readonly string[], input?: string) => Promise<string>;
  cwd: string;
  log: (message: string) => void;
  repository: string;
}
interface ReleaseRecord { tag_name: string; draft: boolean; prerelease: boolean }
interface VersionFile { path: string; data: JsonObject }

const MAIN = 'main';
const MANIFEST = 'custom_components/cookbook/manifest.json';
const VERSION_FILES = [MANIFEST, 'package.json', 'package-lock.json'];
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_MARKER = 'Cookbook-Release: ';
const CHECKS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['npm', ['test']], ['npm', ['run', 'typecheck']],
  ['python3', ['-m', 'pytest', 'tests/integration', '-q']],
];

export class CommandError extends Error {
  constructor(command: string, readonly exitCode: number | null, readonly stderr: string) {
    super(`${command} failed (exit ${exitCode ?? 'unknown'}).`);
    this.name = 'CommandError';
  }
}

const executeCommand: Command = (command, args, { cwd, env, input }) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', () => reject(new CommandError(command, null, 'Unable to start command.')));
  child.on('close', code => code === 0 ? resolvePromise(stdout.trim()) : reject(new CommandError(command, code, stderr)));
  child.stdin.on('error', () => { /* A failing command may close stdin before consuming release notes. */ });
  child.stdin.end(input);
});

function versionParts(version: string): [number, number, number] {
  if (!STABLE_VERSION.test(version)) throw new Error('Expected a stable unprefixed MAJOR.MINOR.PATCH version.');
  const [major, minor, patch] = version.split('.').map(Number);
  if (major === undefined || minor === undefined || patch === undefined ||
      ![major, minor, patch].every(Number.isSafeInteger)) throw new Error('Version components exceed the safe integer range.');
  return [major, minor, patch];
}

export function bumpVersion(version: string, level: Bump): string {
  const [major, minor, patch] = versionParts(version);
  const next = level === 'major' ? [major + 1, 0, 0] : level === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
  const result = next.join('.');
  versionParts(result);
  return result;
}

function commitBump(message: string): Bump | null {
  const [subject = '', ...body] = message.split(/\r?\n/);
  const header = /^([a-z]+)(?:\([^()\r\n]+\))?(!)?: .+/.exec(subject);
  if (!header) return null;
  if (header[2] || body.some(line => /^BREAKING(?: CHANGE|-CHANGE):\s*\S/.test(line))) return 'major';
  return header[1] === 'feat' ? 'minor' : header[1] === 'fix' ? 'patch' : null;
}

export function analyzeCommits(commits: readonly Commit[]): Bump | null {
  const levels = commits.map(commit => commitBump(commit.message));
  return levels.includes('major') ? 'major' : levels.includes('minor') ? 'minor' : levels.includes('patch') ? 'patch' : null;
}

export function parseArguments(args: readonly string[]): Pick<ReleaseOptions, 'mode' | 'resume'> {
  let mode: ReleaseOptions['mode'] | undefined;
  let resume: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === '--preview' || arg === '--publish') && !mode) mode = arg === '--preview' ? 'preview' : 'publish';
    else if (arg === '--resume' && !resume && args[index + 1]) {
      resume = args[++index]!;
      versionParts(resume);
    } else throw new Error('Invalid arguments. Usage: release.ts [--preview | --publish] [--resume MAJOR.MINOR.PATCH]');
  }
  return resume ? { mode: mode ?? 'preview', resume } : { mode: mode ?? 'preview' };
}

function parseRepository(remote: string): string {
  const ssh = /^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  if (ssh?.[1]) return ssh[1];
  try {
    const url = new URL(remote);
    if (url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || url.protocol === 'ssh:') && /^\/[\w.-]+\/[\w.-]+?(?:\.git)?$/.test(url.pathname)) {
      return url.pathname.slice(1).replace(/\.git$/, '');
    }
  } catch { /* Report a fixed message, not a potentially credential-bearing remote URL. */ }
  throw new Error('origin must be a credential-free github.com repository URL.');
}

async function verifyRepository(context: Context): Promise<void> {
  const repository = parseRepository(await context.git('remote', 'get-url', 'origin'));
  const pushUrls = (await context.git('remote', 'get-url', '--push', '--all', 'origin')).split('\n');
  if (pushUrls.length !== 1 || parseRepository(pushUrls[0]!).toLowerCase() !== repository.toLowerCase()) {
    throw new Error('origin must have exactly one push destination matching its GitHub repository.');
  }
  if (context.repository && context.repository.toLowerCase() !== repository.toLowerCase()) throw new Error('Release repository changed during checks.');
  context.repository = repository;
}

async function assertCheckout(context: Context): Promise<void> {
  const { git } = context;
  if ((await git('status', '--porcelain', '--untracked-files=all')).trim()) throw new Error('Release requires a clean working tree, including untracked files.');
  if ((await git('branch', '--show-current')).trim() !== MAIN) throw new Error('Release requires the main branch (not a detached HEAD).');
  if ((await git('rev-parse', '--is-shallow-repository')).trim() !== 'false') throw new Error('Release requires complete, non-shallow Git history.');
}

async function fetchAndCheckSync(context: Context, pendingParent?: string): Promise<void> {
  await assertCheckout(context);
  await verifyRepository(context);
  await context.git('fetch', '--tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const head = await context.git('rev-parse', 'HEAD');
  const remote = await context.git('rev-parse', 'refs/remotes/origin/main');
  if (remote !== head && remote !== pendingParent) throw new Error('main must be synchronized with origin/main before release.');
}

function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid release JSON metadata.');
  return value as JsonObject;
}

function checkVersion(data: JsonObject, path: string, expected: string): void {
  if (data.version !== expected) throw new Error(`${path} version must match ${expected}.`);
  if (path === 'package-lock.json' && object(object(data.packages)['']).version !== expected) {
    throw new Error('Lockfile root package version must match the release version.');
  }
}

async function readVersionFiles(context: Context, expected: string): Promise<VersionFile[]> {
  return Promise.all(VERSION_FILES.map(async path => {
    const original = await readFile(join(context.cwd, path), 'utf8');
    const data = object(JSON.parse(original));
    checkVersion(data, path, expected);
    return { path, data };
  }));
}

function setVersion(data: JsonObject, path: string, version: string): void {
  data.version = version;
  if (path === 'package-lock.json') object(object(data.packages)['']).version = version;
}

async function latestVersion(context: Context, ref = 'HEAD'): Promise<string> {
  const tags = (await context.git('tag', '--merged', ref, '--list')).split('\n').filter(tag => STABLE_VERSION.test(tag));
  tags.forEach(versionParts);
  tags.sort((a, b) => {
    const left = versionParts(a), right = versionParts(b);
    for (const index of [0, 1, 2] as const) if (left[index] !== right[index]) return left[index] > right[index] ? -1 : 1;
    return 0;
  });
  if (!tags[0]) throw new Error('No reachable stable version tag; verify and fetch the existing release baseline first.');
  return tags[0];
}

async function commitsSince(context: Context, tag: string, ref = 'HEAD'): Promise<Commit[]> {
  const raw = await context.git('log', '--format=%H%x00%B%x00', `${tag}..${ref}`);
  const fields = raw.split('\0');
  const commits: Commit[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const hash = fields[index]!.trim(), message = fields[index + 1]!.trim();
    if (hash) commits.push({ hash, message });
  }
  return commits;
}

function releaseNotes(version: string, baseline: string, commits: readonly Commit[]): string {
  return `## ${version}\n\nChanges since ${baseline}:\n\n${commits.map(commit => `- ${commit.message.split('\n')[0]} (${commit.hash.slice(0, 7)})`).join('\n')}\n`;
}

async function githubRelease(context: Context, version: string): Promise<ReleaseRecord | null> {
  try {
    const data = object(JSON.parse(await context.command('gh', [
      'api', '--hostname', 'github.com', `repos/${context.repository}/releases/tags/${version}`,
    ])));
    if (data.tag_name !== version || typeof data.draft !== 'boolean' || typeof data.prerelease !== 'boolean') throw new Error('Unexpected GitHub release response.');
    if (data.draft || data.prerelease) throw new Error('An existing draft or prerelease requires manual review.');
    return { tag_name: version, draft: data.draft, prerelease: data.prerelease };
  } catch (error) {
    if (error instanceof CommandError && /\(HTTP 404\)/.test(error.stderr)) return null;
    throw error;
  }
}

async function runChecks(context: Context, pendingParent?: string): Promise<void> {
  const head = await context.git('rev-parse', 'HEAD');
  for (const [command, args] of CHECKS) {
    context.log(`Checking: ${command} ${args.join(' ')}`);
    await context.command(command, args);
  }
  await fetchAndCheckSync(context, pendingParent);
  if (await context.git('rev-parse', 'HEAD') !== head) throw new Error('HEAD changed during release checks.');
}

async function verifyPending(context: Context, version: string): Promise<{ parent: string; notes: string }> {
  versionParts(version);
  const message = await context.git('log', '-1', '--format=%B');
  const prefix = `chore(release): ${version}\n\n${RELEASE_MARKER}${version}\n\n`;
  if (!message.startsWith(prefix)) throw new Error('Resume requires the original release commit at HEAD.');
  const parents = (await context.git('rev-list', '--parents', '-n', '1', 'HEAD')).split(/\s+/);
  if (parents.length !== 2 || !parents[1]) throw new Error('Resume requires a single-parent release commit.');
  const parent = parents[1];
  const changed = (await context.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).split('\n').sort();
  if (JSON.stringify(changed) !== JSON.stringify([...VERSION_FILES].sort())) throw new Error('Unexpected files in the release commit.');
  const files = await readVersionFiles(context, version);
  let baseline: string | undefined;
  for (const file of files) {
    const previous = object(JSON.parse(await context.git('show', `${parent}:${file.path}`)));
    if (typeof previous.version !== 'string') throw new Error('Invalid previous release version.');
    baseline ??= previous.version;
    checkVersion(previous, file.path, baseline);
    setVersion(previous, file.path, version);
    if (JSON.stringify(previous) !== JSON.stringify(file.data)) throw new Error('Release commit contains changes beyond version metadata.');
  }
  if (!baseline || baseline !== await latestVersion(context, parent)) throw new Error('Previous version must match the original release baseline.');
  const commits = await commitsSince(context, baseline, parent);
  const level = analyzeCommits(commits);
  if (!level || bumpVersion(baseline, level) !== version) throw new Error('Release version does not match the original commits.');
  const notes = message.slice(prefix.length).trim();
  if (notes !== releaseNotes(version, baseline, commits).trim()) throw new Error('Release commit is missing its original notes.');
  return { parent, notes };
}

async function verifyTag(context: Context, version: string): Promise<{ local: boolean; remote: boolean }> {
  const existing = (await context.git('tag', '--list', version)).trim();
  const head = await context.git('rev-parse', 'HEAD');
  if (existing) {
    if (await context.git('cat-file', '-t', `refs/tags/${version}`) !== 'tag' ||
        await context.git('rev-parse', `refs/tags/${version}^{}`) !== head) throw new Error('Existing release tag conflicts with HEAD; manual review required.');
  }
  const remoteTags = await context.git('ls-remote', '--tags', 'origin', `refs/tags/${version}`, `refs/tags/${version}^{}`);
  if (remoteTags) {
    const localTag = existing ? await context.git('rev-parse', `refs/tags/${version}`) : '';
    const refs = remoteTags.split('\n');
    if (!existing || !refs.includes(`${head}\trefs/tags/${version}^{}`) || !refs.includes(`${localTag}\trefs/tags/${version}`)) {
      throw new Error('Remote release tag conflicts with HEAD; manual review required.');
    }
  }
  return { local: Boolean(existing), remote: Boolean(remoteTags) };
}

async function publishPending(context: Context, version: string): Promise<void> {
  try {
    const { parent, notes } = await verifyPending(context, version);
    await fetchAndCheckSync(context, parent);
    const tag = await verifyTag(context, version);
    const existing = await githubRelease(context, version);
    if (existing) {
      if (!tag.remote || await context.git('rev-parse', 'refs/remotes/origin/main') !== await context.git('rev-parse', 'HEAD')) throw new Error('Existing GitHub release does not match the synchronized release tag/state.');
      context.log(`Release ${version} is already published.`);
      return;
    }
    if (!tag.local) await context.git('tag', '-a', version, '-m', `Release ${version}`);
    await context.git('push', '--atomic', 'origin', 'refs/heads/main:refs/heads/main', `refs/tags/${version}:refs/tags/${version}`);
    await context.command('gh', [
      'release', 'create', version, '--repo', context.repository, '--verify-tag',
      '--title', version, '--notes-file', '-',
    ], notes);
    context.log(`Published release ${version}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Release operation failed.';
    throw new Error(`${reason} Inspect the current Git state, then retry with npm run release -- --resume ${version}. No automatic rollback was performed.`);
  }
}

export async function runRelease(options: ReleaseOptions): Promise<void> {
  const env = options.env ?? process.env;
  if ((env.CI && env.CI !== 'false') || env.GITHUB_ACTIONS === 'true' || env.GITLAB_CI === 'true') throw new Error('Releases must be explicitly run locally, not in CI.');
  const cwd = resolve(options.cwd ?? process.cwd());
  const execute = options.execute ?? executeCommand;
  const command = (file: string, args: readonly string[], input?: string) => execute(file, args, {
    cwd, env: { ...env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
    ...(input === undefined ? {} : { input }),
  });
  const context: Context = { cwd, command, git: (...args) => command('git', args), log: options.log ?? console.log, repository: '' };
  await assertCheckout(context);
  await verifyRepository(context);
  await command('gh', ['auth', 'status', '--hostname', 'github.com']);
  if (options.resume) {
    const pending = await verifyPending(context, options.resume);
    await fetchAndCheckSync(context, pending.parent);
    await verifyTag(context, options.resume);
    context.log(`Resume release ${options.resume}\n${pending.notes}`);
    if (options.mode === 'publish') {
      await runChecks(context, pending.parent);
      await publishPending(context, options.resume);
    }
    return;
  }
  await fetchAndCheckSync(context);
  const baseline = await latestVersion(context);
  await readVersionFiles(context, baseline);
  const baselineMessage = await context.git('log', '-1', '--format=%B', baseline);
  if (baselineMessage.includes(`\n${RELEASE_MARKER}${baseline}\n`) && !await githubRelease(context, baseline)) {
    throw new Error(`Release ${baseline} is unfinished; use npm run release -- --resume ${baseline} from its release commit.`);
  }
  const commits = await commitsSince(context, baseline);
  const level = analyzeCommits(commits);
  if (!level) { context.log(`No release-worthy commits since ${baseline}.`); return; }
  const version = bumpVersion(baseline, level);
  const notes = releaseNotes(version, baseline, commits);
  context.log(`Release ${baseline} -> ${version}\n${notes}`);
  if (options.mode === 'preview') return;
  if ((await context.git('tag', '--list', version)).trim() || await githubRelease(context, version)) throw new Error('Selected release version already exists; manual review required.');
  await runChecks(context);
  const files = await readVersionFiles(context, baseline);
  for (const file of files) {
    setVersion(file.data, file.path, version);
    await writeFile(join(cwd, file.path), `${JSON.stringify(file.data, null, 2)}\n`);
  }
  await context.git('add', '--', ...VERSION_FILES);
  await context.git('commit', '-m', `chore(release): ${version}`, '-m', `${RELEASE_MARKER}${version}\n\n${notes}`);
  await publishPending(context, version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runRelease(parseArguments(process.argv.slice(2))); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Release failed.');
    process.exitCode = 1;
  }
}
