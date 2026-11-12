// Exit 1 while loadEnv(mode, root) reads the env files of the working directory instead of root, 0 once it reads root's, 2 when a step fails.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEYS = ['VITE_FROM_ROOT_ENV', 'VITE_FROM_ROOT_PRODUCTION_ENV'];

const countRootKeys = (serverEnv) => KEYS.filter((key) => serverEnv[key] === 'yes').length;

const require = createRequire(import.meta.url);
const folders = [];
let exitCode = 2;
try {
  const vxrnVersion = JSON.parse(readFileSync(require.resolve('vxrn/package.json'), 'utf8')).version;
  console.log(`node ${process.version}, vxrn ${vxrnVersion}, ${process.platform} ${process.arch}`);
  const { loadEnv } = await import('vxrn/loadEnv');

  const root = mkdtempSync(join(tmpdir(), 'load-env-root-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'load-env-cwd-'));
  folders.push(root, elsewhere);
  writeFileSync(join(root, '.env'), 'VITE_FROM_ROOT_ENV=yes\n');
  writeFileSync(join(root, '.env.production'), 'VITE_FROM_ROOT_PRODUCTION_ENV=yes\n');
  console.log('root holds .env (VITE_FROM_ROOT_ENV=yes) and .env.production (VITE_FROM_ROOT_PRODUCTION_ENV=yes)');

  process.chdir(elsewhere);
  const fromElsewhere = countRootKeys((await loadEnv('production', root)).serverEnv);
  console.log(`loadEnv('production', root) with another working directory: ${fromElsewhere} of ${KEYS.length} read`);

  process.chdir(root);
  const fromRoot = countRootKeys((await loadEnv('production', root)).serverEnv);
  console.log(`loadEnv('production', root) with root as the working directory: ${fromRoot} of ${KEYS.length} read`);

  if (fromRoot !== KEYS.length) {
    console.log(`result: loadEnv does not read root's env files even from root (${fromRoot} of ${KEYS.length})`);
  } else if (fromElsewhere === KEYS.length) {
    console.log('result: loadEnv reads the env files of the root it is given');
    exitCode = 0;
  } else {
    console.log(
      `result: loadEnv reads ${fromElsewhere} of ${KEYS.length} variables from the root it is given, and all of them once the working directory is that root`,
    );
    exitCode = 1;
  }
} catch (error) {
  console.log(`result: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
} finally {
  process.chdir(tmpdir());
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
}
process.exit(exitCode);
