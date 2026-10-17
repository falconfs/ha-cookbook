import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import {
  analyzeCommits, bumpVersion, CommandError, parseArguments, runGithub, runRelease,
  type Command, type ReleaseOptions,
} from '../../scripts/release.ts';

const execFileAsync = promisify(execFile);
const VERSION_FILES = ['custom_components/cookbook/manifest.json', 'package.json', 'package-lock.json'];
const CHECKS = ['npm test', 'npm run typecheck', 'python3 -m pytest tests/integration -q'];
const GH_IMAGE = 'serversideup/github-cli:latest';

function dockerGithubArgs(command: string, args: readonly string[]): readonly string[] | undefined {
  const imageIndex = args.indexOf(GH_IMAGE);
  return command === 'docker' && args[0] === 'run' && imageIndex >= 0 ? args.slice(imageIndex + 1) : undefined;
}

test('GitHub commands use Docker with persistent config and no host gh dependency', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cookbook-gh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { HOME: home, GH_TOKEN: 'secret-token', HTTPS_PROXY: 'http://private-proxy.invalid:8080', GH_CONFIG_DIR: '/host/config' };
  let count = 0;
  const execute: Command = async (command, args, options) => {
    count++;
    assert.equal(command, 'docker');
    assert.deepEqual(dockerGithubArgs(command, args), ['auth', 'status', '--hostname', 'github.com']);
    assert.ok(args.includes('type=volume,src=gh-config,dst=/config/gh'));
    assert.ok(args.includes('GH_CONFIG_DIR=/config/gh'));
    assert.ok(args.includes('--rm'));
    assert.ok(args.includes('--interactive'));
    assert.ok(args.includes('GH_TOKEN'));
    assert.ok(args.includes('HTTPS_PROXY'));
    assert.equal(args.join(' ').includes('private-proxy.invalid'), false);
    assert.equal(args.join(' ').includes('secret-token'), false);
    assert.equal(args.join(' ').includes('/host/config'), false);
    assert.equal(args.some(arg => arg.includes('SSL_CERT_FILE')), false);
    assert.equal(options.env.GH_TOKEN, 'secret-token');
    assert.equal(args[args.indexOf('--entrypoint') + 1], 'gh');
    return 'authenticated';
  };
  assert.equal(await runGithub(['auth', 'status', '--hostname', 'github.com'], { cwd: home, env }, execute), 'authenticated');
  assert.equal(count, 1);
});

test('Docker GitHub uses the default CA bundle read-only when it exists', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cookbook-gh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, '.config/certs'), { recursive: true });
  const bundle = join(home, '.config/certs/ca-bundle.pem');
  await writeFile(bundle, 'fixture bundle');
  const execute: Command = async (command, args) => {
    assert.equal(command, 'docker');
    assert.ok(args.includes(`type=bind,src=${bundle},dst=/tmp/ca-bundle.pem,readonly`));
    assert.ok(args.includes('SSL_CERT_FILE=/tmp/ca-bundle.pem'));
    assert.equal(args.some(arg => arg.includes('SKIP_VERIFY') || arg.includes('INSECURE')), false);
    return '';
  };
  await runGithub(['--version'], { cwd: home, env: { HOME: home } }, execute);
});

test('Docker GitHub supports a custom CA path containing spaces', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cookbook-gh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bundle = join(home, 'custom CA.pem');
  await writeFile(bundle, 'fixture bundle');
  const execute: Command = async (_command, args) => {
    assert.ok(args.includes(`type=bind,src=${bundle},dst=/tmp/ca-bundle.pem,readonly`));
    return '';
  };
  await runGithub(['--version'], { cwd: home, env: { HOME: home, COOKBOOK_GH_CA_BUNDLE: bundle } }, execute);
});

test('a missing explicitly configured CA bundle fails before starting Docker', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cookbook-gh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(runGithub(['--version'], {
    cwd: home, env: { HOME: home, COOKBOOK_GH_CA_BUNDLE: join(home, 'missing.pem') },
  }, async () => assert.fail('Docker must not run without the configured CA bundle')), /CA bundle/);
});

test('release notes pass unchanged through Docker stdin without a TTY', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cookbook-gh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const notes = '## 1.1.0\n\n- feat: a "quoted" recipe\n- fix: $HOME stays literal\n';
  const args = ['release', 'create', '1.1.0', '--repo', 'falconfs/ha-cookbook', '--verify-tag', '--notes-file', '-'];
  const execute: Command = async (command, dockerArgs, options) => {
    assert.deepEqual(dockerGithubArgs(command, dockerArgs), args);
    assert.ok(dockerArgs.includes('--interactive'));
    assert.equal(dockerArgs.includes('--tty') || dockerArgs.includes('-t') || dockerArgs.includes('-it'), false);
    assert.equal(options.input, notes);
    return '';
  };
  await runGithub(args, { cwd: home, env: { HOME: home }, input: notes }, execute);
});

test('Docker GitHub quotes a CA source containing CSV metacharacters', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cookbook-gh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bundle = join(home, 'custom,"CA.pem');
  await writeFile(bundle, 'fixture bundle');
  const execute: Command = async (_command, args) => {
    assert.ok(args.includes(`type=bind,"src=${home}/custom,""CA.pem",dst=/tmp/ca-bundle.pem,readonly`));
    return '';
  };
  await runGithub(['--version'], { cwd: home, env: { HOME: home, COOKBOOK_GH_CA_BUNDLE: bundle } }, execute);
});

test('Docker GitHub preserves CLI stderr for HTTP status handling without logging secrets', async t => {
  const home = await mkdtemp(join(tmpdir(), 'cookbook-gh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const error = new CommandError('docker', 1, 'gh: Not Found (HTTP 404) secret-token');
  await assert.rejects(runGithub(['api', 'repos/example/repo/releases/tags/1.0.0'], {
    cwd: home, env: { HOME: home },
  }, async () => { throw error; }), actual => {
    assert.equal(actual, error);
    assert.doesNotMatch(String(actual), /secret-token/);
    assert.match(error.stderr, /HTTP 404/);
    return true;
  });
});

for (const [message, expected] of [
  ['fix: repair import', 'patch'], ['fix(parser): repair import', 'patch'],
  ['feat: add calendar', 'minor'], ['feat(ui)!: change config', 'major'],
  ['chore!: change contract', 'major'],
  ['fix: change config\n\nBREAKING CHANGE: remove old config', 'major'],
  ['feat: change config\n\nBREAKING-CHANGE: remove old config', 'major'],
  ['docs: mention BREAKING CHANGE: only in prose', null],
  ['chore: tooling\n\nfeat: quoted example', null], ['revert: feat: calendar', null],
] as const) {
  test(`commit rule: ${JSON.stringify(message)}`, () => {
    assert.equal(analyzeCommits([{ hash: 'a', message }]), expected);
  });
}

test('the highest commit change level wins', () => {
  const commits = ['fix: a', 'docs: b', 'feat: c'].map(message => ({ hash: 'a', message }));
  assert.equal(analyzeCommits(commits), 'minor');
  assert.equal(analyzeCommits([...commits, { hash: 'b', message: 'fix!: d' }]), 'major');
  assert.equal(analyzeCommits([]), null);
});

test('stable version arithmetic resets lower components', () => {
  assert.equal(bumpVersion('1.2.9', 'patch'), '1.2.10');
  assert.equal(bumpVersion('1.2.9', 'minor'), '1.3.0');
  assert.equal(bumpVersion('1.2.9', 'major'), '2.0.0');
  for (const version of ['v1.0.0', '01.0.0', '1.0.0-beta.1', '9007199254740991.0.0']) {
    assert.throws(() => bumpVersion(version, 'major'), /version/i);
  }
});

test('CLI defaults to preview and rejects ambiguous arguments', () => {
  assert.deepEqual(parseArguments([]), { mode: 'preview' });
  assert.deepEqual(parseArguments(['--publish', '--resume', '1.1.0']), { mode: 'publish', resume: '1.1.0' });
  for (const args of [['--publish', '--preview'], ['--resume'], ['--force'], ['--publish', '--publish']]) {
    assert.throws(() => parseArguments(args), /argument|usage/i);
  }
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cookbook-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'checkout');
  const remote = join(root, 'remote.git');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Release Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Release Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  const gitAt = async (directory: string, ...args: string[]) => {
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, env });
    return result.stdout.trim();
  };
  await mkdir(cwd);
  await gitAt(root, 'init', '--bare', '--initial-branch=main', remote);
  await gitAt(cwd, 'init', '--initial-branch=main');
  const git = (...args: string[]) => gitAt(cwd, ...args);
  const json = async (file: string) => JSON.parse(await readFile(join(cwd, file), 'utf8')) as Record<string, unknown>;
  await mkdir(join(cwd, 'custom_components/cookbook'), { recursive: true });
  await writeFile(join(cwd, VERSION_FILES[0]!), JSON.stringify({ domain: 'cookbook', dependencies: ['http'], version: '1.0.0' }, null, 2) + '\n');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', private: true, version: '1.0.0' }, null, 2) + '\n');
  await writeFile(join(cwd, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '1.0.0' } } }, null, 2) + '\n');
  await git('add', '.');
  await git('commit', '-m', 'feat: initial integration');
  await git('tag', '1.0.0');
  await git('remote', 'add', 'origin', remote);
  await git('push', '--tags', '-u', 'origin', 'main');
  const calls: string[] = [];
  const releases = new Map<string, { tag_name: string; draft: boolean; prerelease: boolean; body: string }>();
  let fail = '';
  let afterCheck: (() => Promise<void>) | undefined;
  let repositoryUrl = 'git@github.com:falconfs/ha-cookbook.git';
  const execute: Command = async (file, args, options) => {
    const githubArgs = dockerGithubArgs(file, args);
    assert.notEqual(file, 'gh', 'Release must not invoke gh on the host');
    if (githubArgs) { file = 'gh'; args = githubArgs; }
    const command = `${file} ${args.join(' ')}`;
    calls.push(command);
    if (command.includes(fail) && fail) throw new CommandError(file, 1, 'simulated failure secret-token');
    if (file === 'gh') {
      if (args[0] === 'auth') return '';
      if (args[0] === 'api') {
        const tag = args.find(arg => arg.startsWith('repos/'))?.split('/tags/')[1];
        if (!tag) return '{}';
        const release = releases.get(decodeURIComponent(tag));
        if (!release) throw new CommandError('gh', 1, 'gh: Not Found (HTTP 404)');
        return JSON.stringify(release);
      }
      if (args[0] === 'release' && args[1] === 'create') {
        const tag = args[2]!;
        if (releases.has(tag)) throw new Error('duplicate release');
        releases.set(tag, { tag_name: tag, draft: false, prerelease: false, body: options.input ?? '' });
        return `https://example.invalid/releases/${tag}`;
      }
      throw new Error(`Unexpected GitHub invocation: ${command}`);
    }
    if (file === 'npm' || file === 'python3') {
      if (command === CHECKS.at(-1)) await afterCheck?.();
      return '';
    }
    assert.equal(file, 'git');
    if (['remote get-url origin', 'remote get-url --push --all origin'].includes(args.join(' '))) return repositoryUrl;
    return git(...args);
  };
  const log: string[] = [];
  const run = (overrides: Partial<ReleaseOptions> = {}) => runRelease({
    cwd, env, mode: 'publish', execute, log: message => log.push(message), ...overrides,
  });
  const commit = async (message: string, push = true) => {
    await git('commit', '--allow-empty', '-m', message);
    if (push) await git('push', 'origin', 'main');
  };
  const snapshot = async () => ({
    head: await git('rev-parse', 'HEAD'), status: await git('status', '--porcelain'),
    tags: await git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags'), remote: await git('ls-remote', 'origin'),
    files: await Promise.all(VERSION_FILES.map(file => readFile(join(cwd, file), 'utf8'))),
  });
  return { cwd, env, remote, git, gitAt, json, calls, releases, run, commit, snapshot, log, execute,
    fail: (value: string) => { fail = value; },
    afterCheck: (value: () => Promise<void>) => { afterCheck = value; },
    repositoryUrl: (value: string) => { repositoryUrl = value; },
  };
}

test('preview reports version/notes without changing files, commits, tags or remote refs', async t => {
  const f = await fixture(t);
  await f.commit('fix(import): repair parsing\n\nPreserve fields.');
  const before = await f.snapshot();
  await f.run({ mode: 'preview' });
  assert.deepEqual(await f.snapshot(), before);
  assert.match(f.log.join('\n'), /1\.0\.1/);
  assert.match(f.log.join('\n'), /repair parsing/);
  assert.equal(f.calls.some(call => call.startsWith('npm ') || call.startsWith('python3 ')), false);
  assert.equal(f.releases.size, 0);
});

test('publication versions only release files, pushes an annotated tag and creates GitHub notes', async t => {
  const f = await fixture(t);
  await f.commit('feat(calendar): add weekly view');
  await f.run();
  for (const file of VERSION_FILES) assert.equal((await f.json(file)).version, '1.1.0');
  assert.equal(((await f.json('package-lock.json')).packages as Record<string, { version: string }>)['']!.version, '1.1.0');
  assert.deepEqual((await f.json(VERSION_FILES[0]!)).dependencies, ['http']);
  assert.equal(await f.git('log', '-1', '--format=%s'), 'chore(release): 1.1.0');
  assert.equal(await f.git('cat-file', '-t', 'refs/tags/1.1.0'), 'tag');
  assert.equal(await f.git('rev-parse', '1.1.0^{}'), await f.git('rev-parse', 'HEAD'));
  assert.deepEqual((await f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).split('\n').sort(), [...VERSION_FILES].sort());
  assert.match(await f.git('ls-remote', '--tags', 'origin'), /refs\/tags\/1\.1\.0/);
  assert.equal(f.releases.size, 1);
  assert.match(f.releases.get('1.1.0')!.body, /add weekly view/);
  const creation = f.calls.find(call => call.startsWith('gh release create'))!;
  assert.match(creation, /--verify-tag/);
  assert.match(creation, /--repo falconfs\/ha-cookbook/);
  assert.match(creation, /--notes-file -/);
  assert.ok(f.calls.includes('git push --atomic origin refs/heads/main:refs/heads/main refs/tags/1.1.0:refs/tags/1.1.0'));
  for (const check of CHECKS) assert.ok(f.calls.indexOf(check) < f.calls.findIndex(call => call.startsWith('git add ')));
});

test('docs/chore-only history is a no-op', async t => {
  const f = await fixture(t);
  await f.commit('docs: update usage');
  await f.commit('chore: adjust tools');
  const before = await f.snapshot();
  await f.run();
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.releases.size, 0);
  assert.match(f.log.join('\n'), /No release/);
});

for (const failure of CHECKS) {
  test(`failed check stops publication: ${failure}`, async t => {
    const f = await fixture(t);
    await f.commit('fix: repair');
    const before = await f.snapshot();
    f.fail(failure);
    await assert.rejects(f.run(), /failed/i);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.releases.size, 0);
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const invalidCheckouts: ReadonlyArray<readonly [string, (f: Fixture) => Promise<void>, RegExp]> = [
  ['untracked file', async f => { await writeFile(join(f.cwd, 'private.txt'), 'private'); }, /clean/],
  ['tracked edit', async f => { await writeFile(join(f.cwd, 'package.json'), '{}'); }, /clean/],
  ['wrong branch', async f => { await f.git('switch', '-c', 'topic'); }, /main/],
  ['detached HEAD', async f => { await f.git('checkout', '--detach'); }, /main|detached/],
  ['ahead', async f => { await f.commit('fix: ahead', false); }, /sync/],
  ['behind', async f => { await f.commit('fix: remote'); await f.git('reset', '--soft', 'HEAD~1'); }, /sync/],
];
for (const [name, setup, message] of invalidCheckouts) {
  test(`rejects ${name} before preparation`, async t => {
    const f = await fixture(t);
    await setup(f);
    const before = await f.snapshot();
    await assert.rejects(f.run(), message);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.releases.size, 0);
  });
}

test('CI and invalid arguments stop before command execution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ env: { ...f.env, CI: 'true' } }), /CI/);
  assert.equal(f.calls.length, 0);
});

test('authentication failure stops before edits without exposing credentials', async t => {
  const f = await fixture(t);
  await f.commit('fix: repair');
  const before = await f.snapshot();
  f.fail('gh auth status');
  await assert.rejects(f.run(), error => {
    assert.doesNotMatch(String(error), /secret-token/);
    return true;
  });
  assert.deepEqual(await f.snapshot(), before);
});

test('Docker startup failure stops before editing release files', async t => {
  const f = await fixture(t);
  await f.commit('fix: repair');
  const before = await f.snapshot();
  const execute: Command = (file, args, options) => {
    if (file === 'docker') throw new CommandError('docker', 125, 'daemon unavailable');
    return f.execute(file, args, options);
  };
  await assert.rejects(f.run({ execute }), /docker failed/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.releases.size, 0);
});

test('version mismatch is rejected before edits', async t => {
  const f = await fixture(t);
  const pkg = await f.json('package.json');
  await writeFile(join(f.cwd, 'package.json'), JSON.stringify({ ...pkg, version: '1.0.1' }));
  await f.git('add', '.');
  await f.commit('fix: mismatched metadata');
  const before = await f.snapshot();
  await assert.rejects(f.run(), /version|match/i);
  assert.deepEqual(await f.snapshot(), before);
});

test('checks that dirty the tree are rejected before version edits', async t => {
  const f = await fixture(t);
  await f.commit('fix: repair');
  f.afterCheck(() => writeFile(join(f.cwd, 'unexpected.txt'), 'check output'));
  await assert.rejects(f.run(), /clean/);
  assert.equal((await f.json('package.json')).version, '1.0.0');
  assert.equal(f.releases.size, 0);
});

for (const boundary of ['git tag -a 1.1.0', 'git push --atomic', 'gh release create']) {
  test(`resumes after ${boundary} failure without a second release commit`, async t => {
    const f = await fixture(t);
    await f.commit('feat: calendar');
    f.fail(boundary);
    await assert.rejects(f.run(), /resume/i);
    const head = await f.git('rev-parse', 'HEAD');
    f.fail('');
    await f.run({ resume: '1.1.0' });
    assert.equal(await f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.releases.size, 1);
    assert.match(f.releases.get('1.1.0')!.body, /calendar/);
    await f.run({ resume: '1.1.0' });
    assert.equal(f.releases.size, 1);
    assert.equal(f.calls.filter(call => call.startsWith('gh release create')).filter(call => !call.includes('secret')).length, boundary === 'gh release create' ? 2 : 1);
  });
}

test('normal publication refuses to skip an unfinished release', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  f.fail('gh release create');
  await assert.rejects(f.run());
  f.fail('');
  await assert.rejects(f.run(), /resume/);
  assert.equal((await f.json('package.json')).version, '1.1.0');
});

test('GitHub server errors are not treated as a missing release', async t => {
  const f = await fixture(t);
  await f.commit('fix: repair');
  const before = await f.snapshot();
  f.fail('gh api');
  await assert.rejects(f.run(), /failed/);
  assert.deepEqual(await f.snapshot(), before);
});

test('CLI token-bearing remote URLs are rejected without printing the URL', async t => {
  const f = await fixture(t);
  f.repositoryUrl('https://secret-token@github.com/falconfs/ha-cookbook.git');
  await assert.rejects(f.run(), error => {
    assert.doesNotMatch(String(error), /secret-token/);
    return true;
  });
});

for (const [message, version] of [
  ['fix: patch', '1.0.1'], ['feat!: breaking API', '2.0.0'],
  ['fix: compatibility\n\nBREAKING CHANGE: remove old options', '2.0.0'],
] as const) {
  test(`commit history selects ${version} for ${message}`, async t => {
    const f = await fixture(t);
    await f.commit(message);
    await f.run({ mode: 'preview' });
    assert.match(f.log.join('\n'), new RegExp(`-> ${version.replaceAll('.', '\\.')}`));
  });
}

test('merged topic commits are included even with a non-conventional merge subject', async t => {
  const f = await fixture(t);
  await f.git('switch', '-c', 'feature/topic');
  await f.git('commit', '--allow-empty', '-m', 'feat: topic functionality');
  await f.git('switch', 'main');
  await f.git('merge', '--no-ff', 'feature/topic', '-m', 'Merge pull request #123');
  await f.git('push', 'origin', 'main');
  await f.run({ mode: 'preview' });
  assert.match(f.log.join('\n'), /-> 1\.1\.0/);
  assert.match(f.log.join('\n'), /topic functionality/);
});

test('baseline selection sorts stable versions numerically and ignores prereleases/unreachable tags', async t => {
  const f = await fixture(t);
  await f.git('tag', '1.9.0');
  await f.git('tag', '1.10.0');
  await f.git('tag', '9.0.0-beta.1');
  await f.git('switch', '-c', 'unmerged');
  await f.git('commit', '--allow-empty', '-m', 'feat: unmerged');
  await f.git('tag', '99.0.0');
  await f.git('switch', 'main');
  for (const file of VERSION_FILES) {
    const data = await f.json(file);
    data.version = '1.10.0';
    if (file === 'package-lock.json') ((data.packages as Record<string, Record<string, unknown>>)['']!).version = '1.10.0';
    await writeFile(join(f.cwd, file), JSON.stringify(data, null, 2) + '\n');
  }
  await f.git('add', '.');
  await f.commit('fix: metadata fixture');
  await f.git('push', '--tags', 'origin');
  await f.run({ mode: 'preview' });
  assert.match(f.log.join('\n'), /Release 1\.10\.0 -> 1\.10\.1/);
});

test('missing stable baseline is rejected rather than inventing a first version', async t => {
  const f = await fixture(t);
  await f.git('tag', '-d', '1.0.0');
  await f.git('push', 'origin', ':refs/tags/1.0.0');
  const before = await f.snapshot();
  await assert.rejects(f.run(), /baseline|version tag/);
  assert.equal((await f.json('package.json')).version, '1.0.0');
  assert.equal(f.releases.size, 0);
  assert.deepEqual(await f.snapshot(), before);
});

test('shallow history is rejected', async t => {
  const f = await fixture(t);
  const execute: Command = (file, args, options) => args.join(' ') === 'rev-parse --is-shallow-repository'
    ? Promise.resolve('true') : f.execute(file, args, options);
  await assert.rejects(f.run({ execute }), /shallow/);
  assert.equal(f.releases.size, 0);
});

test('divergent history is rejected', async t => {
  const f = await fixture(t);
  await f.git('branch', 'divergent');
  await f.commit('fix: remote side');
  await f.git('switch', 'divergent');
  await f.git('commit', '--allow-empty', '-m', 'fix: local side');
  await f.git('branch', '-M', 'main');
  await assert.rejects(f.run(), /sync/);
  assert.equal((await f.json('package.json')).version, '1.0.0');
});

test('remote advancement during checks is rejected before preparing files', async t => {
  const f = await fixture(t);
  await f.commit('fix: release');
  f.afterCheck(async () => {
    const other = join(f.cwd, '..', 'other');
    await f.gitAt(join(f.cwd, '..'), 'clone', f.remote, other);
    await f.gitAt(other, 'commit', '--allow-empty', '-m', 'fix: concurrent remote change');
    await f.gitAt(other, 'push', 'origin', 'main');
  });
  await assert.rejects(f.run(), /sync/);
  assert.equal((await f.json('package.json')).version, '1.0.0');
});

for (const response of ['draft', 'server error', 'malformed']) {
  test(`existing ${response} GitHub release response stops before version edits`, async t => {
    const f = await fixture(t);
    await f.commit('feat: calendar');
    const before = await f.snapshot();
    const execute: Command = (file, args, options) => {
      if (dockerGithubArgs(file, args)?.[0] === 'api') {
        if (response === 'server error') throw new CommandError('gh', 1, 'server unavailable (HTTP 503)');
        return Promise.resolve(response === 'malformed' ? '{}' : JSON.stringify({ tag_name: '1.1.0', draft: true, prerelease: false }));
      }
      return f.execute(file, args, options);
    };
    await assert.rejects(f.run({ execute }));
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.calls.some(call => call.startsWith('git add')), false);
  });
}

test('resume preview leaves a pending release untouched', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  f.fail('git push --atomic');
  await assert.rejects(f.run());
  f.fail('');
  const before = await f.snapshot();
  await f.run({ mode: 'preview', resume: '1.1.0' });
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.releases.size, 0);
});

test('resume rejects a conflicting local tag', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  f.fail('git tag -a');
  await assert.rejects(f.run());
  f.fail('');
  await f.git('tag', '-a', '1.1.0', 'HEAD~1', '-m', 'Conflicting tag');
  await assert.rejects(f.run({ resume: '1.1.0' }), /conflict|baseline/);
  assert.equal(f.releases.size, 0);
});

test('resume rejects additional committed changes hidden in the release files', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  f.fail('git tag -a');
  await assert.rejects(f.run());
  f.fail('');
  const manifest = await f.json(VERSION_FILES[0]!);
  await writeFile(join(f.cwd, VERSION_FILES[0]!), JSON.stringify({ ...manifest, name: 'Injected change' }, null, 2) + '\n');
  await f.git('add', '.');
  await f.git('commit', '--amend', '--no-edit');
  await assert.rejects(f.run({ resume: '1.1.0' }), /beyond version/);
  assert.equal(f.releases.size, 0);
});

test('resume rejects an unexpected file in the release commit', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  f.fail('git tag -a');
  await assert.rejects(f.run());
  f.fail('');
  await writeFile(join(f.cwd, 'extra.txt'), 'extra');
  await f.git('add', '.');
  await f.git('commit', '--amend', '--no-edit');
  await assert.rejects(f.run({ resume: '1.1.0' }), /Unexpected files/);
});

test('resume verifies the selected semantic version against the original commits', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  f.fail('git tag -a');
  await assert.rejects(f.run());
  f.fail('');
  for (const file of VERSION_FILES) {
    const contents = await readFile(join(f.cwd, file), 'utf8');
    await writeFile(join(f.cwd, file), contents.replaceAll('1.1.0', '0.9.0'));
  }
  const message = (await f.git('log', '-1', '--format=%B')).replaceAll('1.1.0', '0.9.0');
  await f.git('add', '.');
  await f.git('commit', '--amend', '-m', message);
  await assert.rejects(f.run({ resume: '0.9.0' }), /version|commits/i);
  assert.equal(f.releases.size, 0);
});

test('a GitHub release without its remote tag is not considered a completed release', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  await f.run();
  await f.git('push', 'origin', ':refs/tags/1.1.0');
  await assert.rejects(f.run({ resume: '1.1.0' }), /tag|state/);
});

test('a subsequent release uses the previous release tag and does not re-release older commits', async t => {
  const f = await fixture(t);
  await f.commit('feat: calendar');
  await f.run();
  const before = await f.snapshot();
  await f.run();
  assert.deepEqual(await f.snapshot(), before);
  await f.commit('fix: calendar sorting');
  await f.run();
  assert.equal((await f.json('package.json')).version, '1.1.1');
  assert.equal(f.releases.size, 2);
  assert.match(f.releases.get('1.1.1')!.body, /calendar sorting/);
  assert.doesNotMatch(f.releases.get('1.1.1')!.body, /feat: calendar/);
});

test('GitHub repository selection ignores ambient GH_REPO and GH_HOST defaults', async t => {
  const f = await fixture(t);
  await f.commit('fix: repair');
  f.repositoryUrl('https://github.com/falconfs/ha-cookbook.git');
  const execute: Command = (file, args, options) => {
    assert.equal(options.env.GH_HOST, 'github.com');
    return f.execute(file, args, options);
  };
  await f.run({ execute, env: { ...f.env, GH_REPO: 'different/repo', GH_HOST: 'other.invalid' } });
  assert.match(f.calls.find(call => call.startsWith('gh release create'))!, /--repo falconfs\/ha-cookbook/);
});

test('unrelated version tags are not pushed during publication', async t => {
  const f = await fixture(t);
  await f.git('tag', 'private-test-tag');
  await f.commit('fix: repair');
  await f.run();
  assert.doesNotMatch(await f.git('ls-remote', '--tags', 'origin'), /private-test-tag/);
});

test('lockfile root metadata mismatch is rejected before any edits', async t => {
  const f = await fixture(t);
  const data = await f.json('package-lock.json');
  ((data.packages as Record<string, Record<string, unknown>>)['']!).version = '0.0.0';
  await writeFile(join(f.cwd, 'package-lock.json'), JSON.stringify(data));
  await f.git('add', '.');
  await f.commit('fix: invalid lock');
  const before = await f.snapshot();
  await assert.rejects(f.run(), /Lockfile root/);
  assert.deepEqual(await f.snapshot(), before);
});

test('a different origin push destination is rejected before preparation', async t => {
  const f = await fixture(t);
  await f.commit('fix: repair');
  const before = await f.snapshot();
  const execute: Command = (file, args, options) => args.join(' ') === 'remote get-url --push --all origin'
    ? Promise.resolve('git@github.com:different/repo.git') : f.execute(file, args, options);
  await assert.rejects(f.run({ execute }), /push destination/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.releases.size, 0);
});
