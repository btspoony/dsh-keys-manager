/**
 * Contract checks for the Antigravity entry's shims: the Bun members the base
 * shim never needed (file, archive, process, socket) and the two Node-backed
 * pieces (`node:sqlite`, the OS lock). Everything here runs offline.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { afterAll, describe, expect, it } from 'vitest'

import { Bun } from '../scripts/omp-shim/bun-global-antigravity.js'
import { Database } from '../scripts/omp-shim/bun-sqlite.js'
import { FileLock } from '../scripts/omp-shim/pi-natives.js'

const scratch = mkdtempSync(join(tmpdir(), 'llm-omp-antigravity-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** One ustar header for a regular file, with a valid checksum. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 100, 'utf8')
  header.write('0000755\0', 100, 8, 'utf8')
  header.write('0000000\0', 108, 8, 'utf8')
  header.write('0000000\0', 116, 8, 'utf8')
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
  header.write('00000000000\0', 136, 12, 'utf8')
  header.write('        ', 148, 8, 'utf8')
  header.write('0', 156, 1, 'utf8')
  header.write('ustar\0', 257, 6, 'utf8')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return header
}

function tarGz(name: string, payload: Buffer): Buffer {
  const padding = Buffer.alloc((512 - (payload.byteLength % 512)) % 512, 0)
  return gzipSync(Buffer.concat([tarHeader(name, payload.byteLength), payload, padding, Buffer.alloc(1024, 0)]))
}

describe('bun-global-antigravity', () => {
  it('reads a file the way Bun.file does, refusing nothing that exists', async () => {
    const path = join(scratch, 'install.json')
    writeFileSync(path, JSON.stringify({ version: '1.5.9' }))

    await expect(Bun.file(path).exists()).resolves.toBe(true)
    await expect(Bun.file(path).json()).resolves.toEqual({ version: '1.5.9' })
    await expect(Bun.file(join(scratch, 'missing.json')).exists()).resolves.toBe(false)
    await expect(Bun.file(join(scratch, 'missing.json')).json()).rejects.toThrowError(/ENOENT/)
  })

  it('unpacks the one executable from the agy tar.gz release', async () => {
    const payload = Buffer.from('#!/bin/sh\necho agy\n')
    const archive = new Bun.Archive(tarGz('antigravity', payload))
    const files = await archive.files()

    expect([...files.keys()]).toEqual(['antigravity'])
    expect(Buffer.from(files.get('antigravity')!).toString()).toBe(payload.toString())
  })

  it('runs a child with piped stdio and reports its exit', async () => {
    const child = Bun.spawn(['node', '-e', 'process.stdout.write("ok")'])
    const chunks: string[] = []
    const reader = child.stdout.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(new TextDecoder().decode(value))
    }

    await expect(child.exited).resolves.toBe(0)
    expect(chunks.join('')).toBe('ok')
  })

  it('exposes a piped stderr and omits it when the stream is not piped', async () => {
    // The sign-in reads agy's stderr as well as its stdout: the authorization URL
    // can arrive on either. Before this, `Bun.spawn` returned no stderr at all,
    // so the pin's `collect(process.stderr)` threw and the whole sign-in surfaced
    // as "Antigravity CLI sign-in failed; try signing in again".
    const piped = Bun.spawn(['node', '-e', 'process.stderr.write("on-stderr")'], { stderr: 'pipe' })
    const chunks: string[] = []
    const reader = piped.stderr!.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(new TextDecoder().decode(value))
    }
    await expect(piped.exited).resolves.toBe(0)
    expect(chunks.join('')).toBe('on-stderr')

    // Ignored stdio stays undefined, as Bun reports it.
    const ignored = Bun.spawn(['node', '-e', ''])
    expect(ignored.stderr).toBeUndefined()
    await expect(ignored.exited).resolves.toBe(0)
  })

  it('accepts one loopback connection and reports the bound port', async () => {
    // The pool binds on later ticks (Node has no synchronous listen); let it warm.
    await new Promise(resolve => setTimeout(resolve, 20))
    const received: string[] = []
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: socket => {
          socket.write('hello\n')
        },
        data: (_socket, chunk) => {
          received.push(new TextDecoder().decode(chunk))
        },
      },
    })

    expect(server.port).toBeGreaterThan(0)
    const reply = await new Promise<string>(resolve => {
      const client = connect(server.port, '127.0.0.1', () => client.write('ping\n'))
      client.on('data', chunk => {
        client.destroy()
        resolve(chunk.toString())
      })
    })
    // The server's data event lands after the client's; give that tick a moment.
    await new Promise(resolve => setTimeout(resolve, 20))
    server.stop(true)

    expect(reply).toBe('hello\n')
    expect(received.join('')).toBe('ping\n')
  })
})

describe('bun-sqlite', () => {
  it('keeps Bun\'s query/transaction shapes over node:sqlite', () => {
    const path = join(scratch, 'conversations.db')
    const db = new Database(path)
    db.exec('CREATE TABLE trajectory_meta (cascade_id TEXT)')
    db.exec("INSERT INTO trajectory_meta VALUES ('cascade-1')")

    expect(db.query('SELECT cascade_id FROM trajectory_meta').all()).toEqual([{ cascade_id: 'cascade-1' }])
    expect(db.query('SELECT 1 AS next').get()).toEqual({ next: 1 })
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO trajectory_meta VALUES ('rolled-back')")
        throw new Error('boom')
      })(),
    ).toThrowError('boom')
    expect(db.query('SELECT count(*) AS n FROM trajectory_meta').get()).toEqual({ n: 1 })
    db.close()

    expect(readFileSync(path).byteLength).toBeGreaterThan(0)
  })
})

describe('pi-natives FileLock', () => {
  it('holds the lock exclusively and releases it', () => {
    const path = join(scratch, 'install.lock')
    const lock = FileLock.tryAcquire(path)
    expect(lock).not.toBeNull()
    expect(FileLock.isHeld(path)).toBe(true)
    expect(FileLock.tryAcquire(path)).toBeNull()

    lock!.release()
    expect(FileLock.isHeld(path)).toBe(false)
    expect(FileLock.tryAcquire(path)).not.toBeNull()
  })
})
