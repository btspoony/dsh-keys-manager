/**
 * Install/load integration evidence.
 *
 * Proves: packing this repository and installing the root tarball into a fresh
 * DSH profile yields BOTH bundle components — the profile's node_modules
 * resolves `dsh-keys-manager` and `dsh-llm-omp-transports`, and the composed
 * profile tree (`dsh --profile <name> --dump-config`) contains both rows, so
 * DSH's loader can mount two components from one installed plugin.
 *
 * Does NOT prove: the plugin-manager detail page and its enable/disable
 * toggles (that rendering is DSH's own Web UI), or any Cursor network behavior.
 *
 * The run is fully local and needs no registry access: both tarballs come from
 * `pnpm pack`, the root's `dsh-llm-omp-transports@^0.1.0` dependency is mapped
 * to the local transports tarball through a profile override, and the profile
 * keeps `autoInstallPeers: false` (DSH peers are provided by the installation).
 * On this pnpm 12 the override lives in pnpm-workspace.yaml; the package.json
 * `pnpm.overrides` copy keeps pnpm 9/10 working.
 *
 * Requires `pnpm` and `dsh` on PATH. Usage: node scripts/verify-install.mjs [--keep]
 */
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const transportsDir = join(repoRoot, 'packages/llm-omp')
const TRANSPORTS = 'dsh-llm-omp-transports'
const PROFILE = 'install-proof'
/** The two loader rows the composed profile must carry. */
const ROWS = [
  { id: 'dsh-keys-manager', name: 'dsh-keys-manager' },
  { id: 'llm-omp-transports', name: TRANSPORTS },
]

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    })
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join('\n')
    throw new Error(`${command} ${args.join(' ')} failed (${error.code ?? 'error'}):\n${output}`)
  }
}

async function manifestOf(dir) {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
}

/** One loader row, quoted or plain, exactly once in the dumped tree. */
function assertRow(dump, { id, name }) {
  const row = new RegExp(`^- id: ${id}\\n  name: '?${name}'?$`, 'mu')
  if (!row.test(dump)) throw new Error(`dump-config is missing the ${id} row:\n${dump}`)
  const count = dump.split(`- id: ${id}\n`).length - 1
  if (count !== 1) throw new Error(`dump-config carries the ${id} row ${count} times:\n${dump}`)
}

let work
try {
  for (const command of ['pnpm', 'dsh']) await run(command, ['--version'])

  work = await mkdtemp(join(tmpdir(), 'dsh-install-proof-'))
  const artifacts = join(work, 'artifacts')
  await mkdir(artifacts, { recursive: true })

  const root = await manifestOf(repoRoot)
  const transports = await manifestOf(transportsDir)
  await run('pnpm', ['pack', '--pack-destination', artifacts], { cwd: repoRoot })
  await run('pnpm', ['pack', '--pack-destination', artifacts], { cwd: transportsDir })
  const rootTarball = join(artifacts, `${root.name}-${root.version}.tgz`)
  const transportsTarball = join(artifacts, `${TRANSPORTS}-${transports.version}.tgz`)
  await access(rootTarball)
  await access(transportsTarball)

  // A packed workspace dependency must be a registry range, not `workspace:^`.
  // The transports package ships from the same release version, so the
  // expected range follows its manifest rather than a pinned literal.
  const expectedRange = `^${transports.version}`
  const packed = JSON.parse((await run('tar', ['-xzOf', rootTarball, 'package/package.json'])).stdout)
  const pinned = packed.dependencies?.[TRANSPORTS]
  if (pinned !== expectedRange) {
    throw new Error(`packed root dependency ${TRANSPORTS} is ${JSON.stringify(pinned)}, expected ${JSON.stringify(expectedRange)}`)
  }
  console.log(`install-proof: packed dependency ${TRANSPORTS} -> ${pinned}`)

  // A fresh profile: `dsh plugin install` initializes it (and runs pnpm).
  const home = join(work, 'home')
  const profileDir = join(home, 'profiles', PROFILE)
  const env = { ...process.env, DSH_HOME: home }
  await run('dsh', ['plugin', '--profile', PROFILE, 'install'], { env })

  // Map the root's registry dependency to the local tarball before installing.
  const profileManifest = await manifestOf(profileDir)
  profileManifest.pnpm = {
    ...profileManifest.pnpm,
    overrides: { ...profileManifest.pnpm?.overrides, [TRANSPORTS]: `file:${transportsTarball}` },
  }
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(profileManifest, undefined, 2)}\n`)
  await writeFile(
    join(profileDir, 'pnpm-workspace.yaml'),
    [
      '# Local tarball mapping for the install proof; the packed root asks for',
      `# ${TRANSPORTS}@${expectedRange}, which no registry here serves.`,
      'overrides:',
      `  ${TRANSPORTS}: ${JSON.stringify(`file:${transportsTarball}`)}`,
      'packages:',
      '  - .',
      '',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      '',
    ].join('\n'),
  )

  // The alias form (`name@file:...`) is what pnpm 12 accepts for tarballs.
  await run('dsh', ['plugin', '--profile', PROFILE, 'add', `${root.name}@file:${rootTarball}`], {
    cwd: work,
    env,
  })

  const installed = await manifestOf(profileDir)
  if (installed.dependencies?.[root.name] !== `file:${rootTarball}`) {
    throw new Error(`profile does not depend on the packed root: ${JSON.stringify(installed.dependencies)}`)
  }
  if (!installed.dsh?.profile?.bundles?.includes(root.name)) {
    throw new Error(`profile did not select ${root.name} as a bundle: ${JSON.stringify(installed.dsh)}`)
  }
  const versions = []
  for (const name of [root.name, TRANSPORTS]) {
    const manifest = JSON.parse(await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
    if (manifest.name !== name) throw new Error(`${name} resolves to ${JSON.stringify(manifest.name)}`)
    versions.push(`${name}@${manifest.version}`)
  }
  console.log(`install-proof: both components installed: ${versions.join(' + ')}`)

  const dump = (await run('dsh', ['--profile', PROFILE, '--dump-config'], { env })).stdout
  for (const row of ROWS) assertRow(dump, row)
  console.log('install-proof: dump-config rows:')
  for (const { id, name } of ROWS) console.log(`  - id: ${id}\n    name: ${name}`)
  console.log('install-proof: OK')
} catch (error) {
  console.error(`install-proof: FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  if (work !== undefined) {
    if (process.argv.includes('--keep')) console.log(`install-proof: kept ${work}`)
    else await rm(work, { recursive: true, force: true })
  }
}
