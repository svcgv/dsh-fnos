import { createServer } from 'node:net'

/**
 * Ask the kernel for a free loopback port.
 * The instance is bound per project on demand, so a per-process allocation is enough.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('无法分配本地端口')))
        return
      }
      const { port } = address
      server.close((error) => (error === undefined ? resolve(port) : reject(error)))
    })
  })
}
