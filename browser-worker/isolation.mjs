// Experimental launcher for a fixed local Chromium, not a production sandbox.
// All inputs come from the worker; never expose this function to web clients.
import { openSync, closeSync, lstatSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { assertFixtureControl, fixtureNetworkSetup, fixtureInner } from './fixture-http.mjs'

// A short, worker-owned host socket is a positive control for the namespace test.
// Never accept its path from callers or environment variables.
const probes = new WeakMap()
function waitFor(setup, signal, timeout = 3000) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted)
      error ? reject(error) : resolve(value)
    }
    const aborted = () => finish(signal.reason || new Error('probe cancelled'))
    const timer = setTimeout(() => finish(new Error('probe timed out')), timeout)
    if (signal?.aborted) { aborted(); return }
    signal?.addEventListener('abort', aborted, {once:true})
    try { setup(finish) } catch (error) { finish(error) }
  })
}
export async function createIsolationProbe(signal) {
  if (realpathSync('/tmp') !== '/tmp') throw new Error('invalid probe parent')
  const tmp = lstatSync('/tmp')
  if (!tmp.isDirectory() || tmp.isSymbolicLink() || tmp.uid !== 0 || ((tmp.mode & 0o022) && !(tmp.mode & 0o1000))) throw new Error('invalid probe parent')
  const dir = mkdtempSync('/tmp/dsh-browser-probe-')
  let server, client, closed
  const connections = new Set()
  async function dispose() {
    if (closed) return closed
    closed = (async () => {
      client?.destroy()
      for (const socket of connections) socket.destroy()
      if (server) await waitFor(done => server.close(error => done(error?.code === 'ERR_SERVER_NOT_RUNNING' ? null : error)))
      rmSync(dir, {recursive:true,force:true})
    })()
    return closed
  }
  try {
    const info = lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || realpathSync(dir) !== dir) throw new Error('invalid probe directory')
    const socketPath = path.join(dir,'probe.sock')
    server = net.createServer(socket => {
      connections.add(socket); socket.on('error',()=>{}); socket.once('close',()=>connections.delete(socket)); socket.end('ok')
    })
    server.on('error',()=>{})
    await waitFor(done => { server.once('error',done); server.listen(socketPath,()=>done()) },signal)
    if (!lstatSync(socketPath).isSocket()) throw new Error('invalid probe socket')
    await waitFor(done => {
      client = net.createConnection(socketPath)
      let value = ''
      client.on('data',data=>value+=data)
      client.once('error',done)
      client.once('end',()=>done(value === 'ok' ? null : new Error('probe positive control failed')))
    },signal)
    client.destroy(); client = undefined
    const probe = Object.freeze({socketPath,dispose})
    probes.set(probe,{dir,socketPath,server})
    return probe
  } catch (error) {
    try { await dispose() } catch (cleanupError) { throw new AggregateError([error,cleanupError],'probe cleanup failed') }
    throw error
  }
}

const runtime = '/vol1/@appcenter/fygo-browser/app/vendor/runtime'
const atomic = '/vol1/@appcenter/dsh-fnos/runtime/lib/libatomic.so.1'
const nodeBin = '/var/apps/nodejs_v26/target/bin/node'
export const isolatedInner = String.raw`
const {spawn} = require('node:child_process');
const fs = require('node:fs'), net = require('node:net');
if (process.getuid() !== 1000 || process.getgid() !== 1000) { console.error('invalid mapped uid/gid'); process.exit(72); }
try { fs.statSync(process.env.HOST_CHECK); console.error('host test directory is visible'); process.exit(73); }
catch (e) { if (e.code !== 'ENOENT') { console.error('host test directory check failed'); process.exit(73); } }
const check = net.createConnection(process.env.HOST_SOCKET);
check.on('connect',()=>{check.destroy();console.error('host socket is reachable');process.exit(73)});
check.on('error',e=>{
  if (e.code !== 'ENOENT') { console.error('host socket check failed');process.exit(73); }
  const env = {HOME:'/tmp/home',PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LD_LIBRARY_PATH:'/runtime/usr/lib/x86_64-linux-gnu:/runtime/lib/x86_64-linux-gnu:/runtime/usr/lib/chromium:/runtime/usr/lib/x86_64-linux-gnu/pulseaudio'};
  const args=['--headless','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-pipe','--user-data-dir=/tmp/home/profile'];
  if(process.env.HOST_NETWORK==='1')args.push('--block-new-web-contents','--no-first-run','--no-default-browser-check','--disable-background-networking');
  args.push('about:blank');
  const p = spawn('/runtime/usr/lib/chromium/chromium',args,{env,stdio:['ignore','ignore','ignore',3,4]});
  p.on('error',e=>{console.error('chromium launch failed:',e.message);process.exitCode=1});
  p.on('exit',(code,signal)=>{process.exitCode=code===0?0:1});
});
`
// Namespace FDs 5..8 are opened on the parent worker itself. Never mount until
// every descriptor is verified distinct; close them before exposing the new root.
export const namespaceGuard = String.raw`
set -eu
for pair in user:5 mnt:6 pid:7 net:8; do
  kind=${'$'}{pair%:*}; fd=${'$'}{pair#*:}
  test -e "/proc/self/ns/$kind" && test -e "/proc/self/fd/$fd" || exit 70
  target=$(/usr/bin/readlink "/proc/self/fd/$fd") || exit 70
  case "$target" in "$kind":\[*\]) ;; *) exit 70 ;; esac
  if test "/proc/self/ns/$kind" -ef "/proc/self/fd/$fd"; then echo "namespace not isolated: $kind" >&2; exit 71; fi
done
exec 5<&- 6<&- 7<&- 8<&-
`
export const hostNetworkNamespaceGuard = String.raw`
set -eu
for pair in user:5 mnt:6 pid:7; do
  kind=${'$'}{pair%:*}; fd=${'$'}{pair#*:}
  test -e "/proc/self/ns/$kind" && test -e "/proc/self/fd/$fd" || exit 70
  target=$(/usr/bin/readlink "/proc/self/fd/$fd") || exit 70
  case "$target" in "$kind":\[*\]) ;; *) exit 70 ;; esac
  if test "/proc/self/ns/$kind" -ef "/proc/self/fd/$fd"; then echo "namespace not isolated: $kind" >&2; exit 71; fi
done
exec 5<&- 6<&- 7<&-
`
function launcher(fixture, hostNetwork) {
  const guard = hostNetwork ? hostNetworkNamespaceGuard : namespaceGuard
  const networkMounts = hostNetwork ? String.raw`
ro_dir /etc/ssl "$ROOT/etc/ssl"
ro_dir /etc/ca-certificates "$ROOT/etc/ca-certificates"
ro_dir /usr/share/ca-certificates "$ROOT/usr/share/ca-certificates"
ro_file /etc/resolv.conf "$ROOT/etc/resolv.conf"
ro_file /etc/hosts "$ROOT/etc/hosts"
ro_file /etc/nsswitch.conf "$ROOT/etc/nsswitch.conf"
ro_dir /usr/lib/x86_64-linux-gnu "$ROOT/usr/lib/x86_64-linux-gnu"
ro_dir /lib/x86_64-linux-gnu "$ROOT/lib/x86_64-linux-gnu"
` : ''
  const capabilityMounts = fixture
    ? 'ro_file /usr/bin/setpriv "$ROOT/usr/bin/setpriv"\nro_file /lib/x86_64-linux-gnu/libcap-ng.so.0 "$ROOT/lib/x86_64-linux-gnu/libcap-ng.so.0"'
    : ''
  const libMounts = hostNetwork
    ? ''
    : 'for lib in libc.so.6 libmount.so.1 libblkid.so.1 libselinux.so.1 libpcre2-8.so.0; do ro_file "/lib/x86_64-linux-gnu/$lib" "$ROOT/lib/x86_64-linux-gnu/$lib"; done'
  return String.raw`${guard}
${fixture ? fixtureNetworkSetup : ''}
/usr/bin/mount --make-rprivate /
/usr/bin/mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$ROOT"
/usr/bin/mkdir -p "$ROOT"/{runtime/usr/lib/chromium,runtime/usr/lib/x86_64-linux-gnu,runtime/lib/x86_64-linux-gnu,dev,proc,tmp/home,oldroot,usr/bin,usr/lib/x86_64-linux-gnu,usr/share/fonts,usr/share/fontconfig,usr/share/ca-certificates,etc/fonts,etc/ssl,etc/ca-certificates,lib/x86_64-linux-gnu,lib64,extra}
/usr/bin/chmod 1777 "$ROOT/tmp"
/usr/bin/chmod 700 "$ROOT/tmp/home"
ro_dir() { /usr/bin/mount --bind "$1" "$2"; /usr/bin/mount -o remount,bind,ro,nosuid,nodev "$2"; }
ro_file() { /usr/bin/touch "$2"; /usr/bin/mount --bind "$1" "$2"; /usr/bin/mount -o remount,bind,ro,nosuid,nodev "$2"; }
ro_dir "$RUNTIME/usr/lib/chromium" "$ROOT/runtime/usr/lib/chromium"
ro_dir "$RUNTIME/usr/lib/x86_64-linux-gnu" "$ROOT/runtime/usr/lib/x86_64-linux-gnu"
ro_dir "$RUNTIME/lib/x86_64-linux-gnu" "$ROOT/runtime/lib/x86_64-linux-gnu"
ro_dir "$RUNTIME/etc/fonts" "$ROOT/etc/fonts"
ro_dir "$RUNTIME/usr/share/fonts" "$ROOT/usr/share/fonts"
ro_dir "$RUNTIME/usr/share/fontconfig" "$ROOT/usr/share/fontconfig"
${networkMounts}
for program in unshare umount; do ro_file "/usr/bin/$program" "$ROOT/usr/bin/$program"; done
ro_file "$NODE_BIN" "$ROOT/usr/bin/node"
ro_file "$ATOMIC" "$ROOT/extra/libatomic.so.1"
ro_file /lib64/ld-linux-x86-64.so.2 "$ROOT/lib64/ld-linux-x86-64.so.2"
${libMounts}
${capabilityMounts}
for device in null zero random urandom; do /usr/bin/touch "$ROOT/dev/$device"; /usr/bin/mount --bind "/dev/$device" "$ROOT/dev/$device"; done
/usr/bin/mount -t proc -o nosuid,nodev,noexec proc "$ROOT/proc"
/usr/sbin/pivot_root "$ROOT" "$ROOT/oldroot"
cd /
/usr/bin/umount -l /oldroot
${fixture ? 'exec /usr/bin/unshare --keep-caps --user --map-user=1000 --map-group=1000 /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs /usr/bin/node --input-type=commonjs -e "$INNER"' : 'exec /usr/bin/unshare --user --map-user=1000 --map-group=1000 /usr/bin/node --input-type=commonjs -e "$INNER"'}
` }

export function spawnIsolatedBrowser(root, probe, fixtureControl, { hostNetwork = false } = {}) {
  if (typeof hostNetwork !== 'boolean') throw new Error('invalid host network mode')
  if (hostNetwork && fixtureControl !== undefined) throw new Error('host-network browser cannot use the fixed fixture')
  if (fixtureControl !== undefined) assertFixtureControl(fixtureControl)
  const probeState = probes.get(probe)
  if (!probeState?.server.listening || !lstatSync(probeState.socketPath).isSocket()) throw new Error('active isolation probe required')
  if (process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() === 0) throw new Error('isolated mode requires non-root Linux x64')
  const parent = path.dirname(root)
  if (path.basename(root) !== 'root' || path.dirname(parent) !== os.tmpdir() || !/^dsh-browser-worker-[a-zA-Z0-9]{6}$/.test(path.basename(parent))) throw new Error('invalid isolated root')
  for (const dir of [parent, root]) {
    const info = lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || realpathSync(dir) !== dir) throw new Error('invalid isolated root owner or permissions')
  }
  const descriptors = []
  try {
    for (const ns of hostNetwork ? ['user','mnt','pid'] : ['user','mnt','pid','net']) descriptors.push(openSync(`/proc/self/ns/${ns}`, 'r'))
    const fixture = fixtureControl !== undefined
    const env = {PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C.UTF-8',ROOT:root,HOST_CHECK:parent,HOST_SOCKET:probeState.socketPath,RUNTIME:runtime,NODE_BIN:nodeBin,ATOMIC:atomic,INNER:fixture ? fixtureInner : isolatedInner,HOST_NETWORK:hostNetwork ? '1' : '',LD_LIBRARY_PATH:'/extra:/runtime/usr/lib/x86_64-linux-gnu:/runtime/lib/x86_64-linux-gnu'}
    const namespaceArgs = hostNetwork ? ['--map-root-user','--mount','--pid'] : ['--map-root-user','--mount','--pid','--net']
    return spawn('/usr/bin/unshare', [...namespaceArgs,'--fork','--kill-child','/bin/bash','-c',launcher(fixture, hostNetwork)], {env,detached:true,stdio:['ignore','ignore','pipe','pipe','pipe',...descriptors]})
  } finally { for (const fd of descriptors) closeSync(fd) }
}
