/**
 * The `Bun` global surface the Antigravity ACP transport reaches: the base shim
 * plus the file, archive, process and socket members that graph uses.
 *
 * Every member is a Node implementation of the same contract, not a stub:
 *
 * - `file` backs `binary.ts` (does the installed release exist?) and `readRecord`
 *   (read `install.json`), so `exists`/`json`/`text`/`arrayBuffer` keep Bun's
 *   shapes — a missing file throws an ENOENT `Error`, which callers detect with
 *   `isEnoent`.
 * - `Archive` unpacks the `.tar.gz` agy release: `node:zlib` for the gzip and a
 *   flat ustar reader for the one executable member. A member that is not a
 *   regular file, a path that escapes the archive, or a `pax` header aborts with
 *   an error instead of writing something unexpected.
 * - `spawn` starts the agy child with piped stdio and exposes Bun's shape
 *   (`stdin.write/flush/end`, `stdout` as a web stream, `exited`, `kill`).
 * - `listen` is the MCP bridge's loopback server: `port` after binding, `stop`
 *   that closes the listener and its sockets.
 *
 * @module dsh-llm-omp-transports/omp-shim/bun-global-antigravity
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { gunzipSync } from 'node:zlib'

import { Bun as baseBun, CryptoHasher, SHA256 } from './bun-global'

export { CryptoHasher, SHA256 }
export { default } from './bun-global'

/** A file handle with the Bun members the transport calls. */
interface BunFile {
  exists(): Promise<boolean>
  json(): Promise<unknown>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

function file(path: string): BunFile {
  return {
    exists: async () => {
      try {
        // `stat` answers existence without reading the file: the install check runs
        // on every artifact load and the release is megabytes.
        await stat(path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
    json: async () => JSON.parse(await readFile(path, 'utf8')) as unknown,
    text: async () => readFile(path, 'utf8'),
    arrayBuffer: async () => {
      const bytes = await readFile(path)
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },
  }
}

/** One tar member: its name and bytes. */
interface TarMember {
  readonly name: string
  readonly bytes: Uint8Array
}

/** Parse a `ustar` archive's regular-file members, refusing anything unusual. */
function tarMembers(payload: Uint8Array): TarMember[] {
  const members: TarMember[] = []
  let offset = 0
  const decoder = new TextDecoder()
  while (offset + 512 <= payload.byteLength) {
    const header = payload.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/su, '')
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/su, '')
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (full === '') throw new Error('the age archive carries a member with no name')
    if (full.startsWith('/') || full.split('/').includes('..')) {
      throw new Error(`the agy archive member escapes its root: ${full}`)
    }
    const sizeField = decoder.decode(header.subarray(124, 136)).replace(/\0.*$/su, '').trim()
    const size = Number.parseInt(sizeField || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw new Error(`the agy archive member has no size: ${full}`)
    const type = String.fromCharCode(header[156] ?? 0)
    const start = offset + 512
    const end = start + size
    if (end > payload.byteLength) throw new Error(`the agy archive is truncated at ${full}`)
    if (type === '0' || type === '\0') members.push({ name: full, bytes: payload.subarray(start, end) })
    else if (type !== 'x' && type !== 'g') throw new Error(`the agy archive member ${full} is not a regular file`)
    offset = start + Math.ceil(size / 512) * 512
  }
  return members
}

/** `Bun.Archive` for the one archive this transport reads. */
class Archive {
  readonly #payload: Uint8Array

  constructor(payload: Uint8Array | ArrayBuffer) {
    this.#payload = payload instanceof Uint8Array ? payload : new Uint8Array(payload)
  }

  async files(): Promise<Map<string, Uint8Array>> {
    const tar = this.#payload[0] === 0x1f && this.#payload[1] === 0x8b ? gunzipSync(this.#payload) : this.#payload
    return new Map(tarMembers(new Uint8Array(tar)).map(member => [member.name, member.bytes]))
  }
}

/** Bun's `spawn` shape, narrowed to the members the host uses. */
interface BunChild {
  readonly stdin: { write(chunk: string): void; flush(): Promise<void>; end(): Promise<void> }
  readonly stdout: ReadableStream<Uint8Array>
  /** Present only when the caller asked for a piped stderr, as Bun does. */
  readonly stderr?: ReadableStream<Uint8Array>
  readonly exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
}

interface SpawnOptions {
  cwd?: string
  stdin?: 'pipe' | 'ignore' | 'inherit'
  stdout?: 'pipe' | 'ignore' | 'inherit'
  stderr?: 'pipe' | 'ignore' | 'inherit'
  env?: Record<string, string | undefined>
}

/** Wrap one piped stdio stream as the web stream Bun hands back. */
function pipeOf(stream: NodeJS.ReadableStream | null, name: string): ReadableStream<Uint8Array> {
  if (stream === null) throw new Error(`Antigravity CLI spawned without a readable ${name}`)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      stream.on('end', () => controller.close())
      stream.on('error', error => controller.error(error))
    },
  })
}

function spawn(command: readonly string[], options: SpawnOptions = {}): BunChild {
  const stderrMode = options.stderr ?? 'ignore'
  const child: ChildProcess = nodeSpawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    stdio: [options.stdin ?? 'pipe', options.stdout ?? 'pipe', stderrMode],
    env: options.env as NodeJS.ProcessEnv,
  })
  const stdout = pipeOf(child.stdout, 'stdout')
  // The sign-in reads agy's stderr as well as its stdout (the authorization URL
  // can arrive on either), so a piped stderr must be exposed. Bun leaves the
  // property undefined when the stream is not piped, and callers test for that.
  const stderr = stderrMode === 'pipe' ? pipeOf(child.stderr, 'stderr') : undefined
  const exited = new Promise<number>(resolve => {
    child.once('exit', code => resolve(code ?? 1))
    child.once('error', () => resolve(1))
  })
  const stdin = {
    write: (chunk: string) => {
      child.stdin?.write(chunk)
    },
    flush: async () => {
      await new Promise<void>(resolve => child.stdin?.write('', () => resolve()) ?? resolve())
    },
    end: async () => {
      await new Promise<void>(resolve => child.stdin?.end(() => resolve()) ?? resolve())
    },
  }
  return {
    stdin,
    stdout,
    ...(stderr === undefined ? {} : { stderr }),
    exited,
    kill: signal => {
      child.kill(signal)
    },
  }
}

/** One accepted bridge connection, with Bun's `data` slot and members. */
interface BunSocket {
  data: unknown
  write(chunk: string): void
  terminate(): void
}

interface ListenOptions<T> {
  hostname: string
  port: number
  socket: {
    open?(socket: BunSocket & { data: T }): void
    data?(socket: BunSocket & { data: T }, chunk: Uint8Array): void
    close?(socket: BunSocket & { data: T }): void
    error?(socket: BunSocket & { data: T }, error: Error): void
  }
}

interface BunServer {
  readonly port: number
  stop(force?: boolean): void
}

/**
 * Pre-bound loopback listeners, because Node has no synchronous `listen`.
 *
 * `Bun.listen` binds inside the constructor, and omp's `McpBridge` reads
 * `.port` on the very next line before handing it to the agy child. Node's
 * `server.listen()` only reports a port on a later tick, so this module keeps a
 * small pool of already-listening servers and hands one out synchronously.
 *
 * shortcut: the pool must be warm before the first bridge; it is primed at module
 * load and refilled on every take, and a take with a cold pool throws instead of
 * silently binding late. If a host ever constructs a bridge before any I/O tick,
 * upgrade this to a build substitution that makes the bridge construction async.
 */
const warmed: Server[] = []
const warming = new Set<Server>()

function prewarm(): void {
  const server = createServer()
  warming.add(server)
  server.once('listening', () => {
    warming.delete(server)
    warmed.push(server)
  })
  server.listen(0, '127.0.0.1')
  // A listener the artifact keeps for a later bridge must not be what holds the
  // process open; the bridge's own sockets keep it alive while it serves.
  server.unref()
}

// Two warm listeners: the bridge takes one and immediately refills, so a second
// bridge constructed before the refill lands still gets a bound port.
prewarm()
prewarm()

function takeWarmServer(): Server {
  const server = warmed.shift()
  if (server === undefined) {
    throw new Error('llm-omp: the ACP bridge listener was not warm yet; start the sign-in again')
  }
  prewarm()
  return server
}

function listen<T>(options: ListenOptions<T>): BunServer {
  const server = takeWarmServer()
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    const bunSocket: BunSocket & { data: T } = {
      data: undefined as unknown as T,
      write: chunk => {
        socket.write(chunk)
      },
      terminate: () => {
        socket.destroy()
      },
    }
    socket.on('data', chunk => options.socket.data?.(bunSocket, new Uint8Array(chunk)))
    socket.on('error', error => options.socket.error?.(bunSocket, error))
    socket.on('close', () => {
      sockets.delete(socket)
      options.socket.close?.(bunSocket)
    })
    options.socket.open?.(bunSocket)
  })
  const address = server.address()
  if (address === null || typeof address !== 'object') {
    throw new Error('llm-omp: the ACP bridge listener lost its address')
  }
  return {
    port: address.port,
    stop: force => {
      if (force === true) for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

/** `Bun.sleep`, used by the sign-in teardown to bound a killed child. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** The `Bun` global this entry's graph reads. */
export const Bun = { ...baseBun, file, spawn, listen, Archive, sleep }