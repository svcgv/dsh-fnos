#!/usr/bin/env node
// Research-only integration probe: creates no service and uses only self-owned data.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

const runtime = '/vol1/@appcenter/fygo-browser/app/vendor/runtime';
const atomic = '/vol1/@appcenter/dsh-fnos/runtime/lib/libatomic.so.1';
const nodeBin = '/var/apps/nodejs_v26/target/bin/node';
if (process.arch !== 'x64' || process.platform !== 'linux' || process.getuid() === 0) {
  console.error('Requires Linux x64 and a non-root account.'); process.exit(1);
}
let dir, root, secret, socketPath, server, child;
const connections = new Set();
const parentNs = [];
const launcher = String.raw`
set -eu
# File descriptors 3–6 were opened by the parent before spawning unshare.
# Fail closed on missing or identical namespace IDs before any mount operation.
for pair in user:3 mnt:4 pid:5 net:6; do
  kind=${'$'}{pair%:*}; fd=${'$'}{pair#*:}
  test -e "/proc/self/ns/$kind" && test -e "/proc/self/fd/$fd" || exit 70
  if test "/proc/self/ns/$kind" -ef "/proc/self/fd/$fd"; then echo "namespace not isolated: $kind" >&2; exit 71; fi
done
exec 3<&- 4<&- 5<&- 6<&-
/usr/bin/mount --make-rprivate /
/usr/bin/mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$ROOT"
/usr/bin/mkdir -p "$ROOT"/{runtime/usr/lib/chromium,runtime/usr/lib/x86_64-linux-gnu,runtime/lib/x86_64-linux-gnu,dev,proc,tmp,oldroot,usr/bin,lib/x86_64-linux-gnu,lib64,extra}
/usr/bin/chmod 1777 "$ROOT/tmp"
ro_dir() { /usr/bin/mount --bind "$1" "$2"; /usr/bin/mount -o remount,bind,ro,nosuid,nodev "$2"; }
ro_file() { /usr/bin/touch "$2"; /usr/bin/mount --bind "$1" "$2"; /usr/bin/mount -o remount,bind,ro,nosuid,nodev "$2"; }
ro_dir "$RUNTIME/usr/lib/chromium" "$ROOT/runtime/usr/lib/chromium"
ro_dir "$RUNTIME/usr/lib/x86_64-linux-gnu" "$ROOT/runtime/usr/lib/x86_64-linux-gnu"
ro_dir "$RUNTIME/lib/x86_64-linux-gnu" "$ROOT/runtime/lib/x86_64-linux-gnu"
for program in unshare umount; do ro_file "/usr/bin/$program" "$ROOT/usr/bin/$program"; done
ro_file "$NODE_BIN" "$ROOT/usr/bin/node"
ro_file "$ATOMIC" "$ROOT/extra/libatomic.so.1"
ro_file /lib64/ld-linux-x86-64.so.2 "$ROOT/lib64/ld-linux-x86-64.so.2"
for lib in libc.so.6 libmount.so.1 libblkid.so.1 libselinux.so.1 libpcre2-8.so.0; do ro_file "/lib/x86_64-linux-gnu/$lib" "$ROOT/lib/x86_64-linux-gnu/$lib"; done
for device in null zero random urandom; do /usr/bin/touch "$ROOT/dev/$device"; /usr/bin/mount --bind "/dev/$device" "$ROOT/dev/$device"; done
/usr/bin/mount -t proc -o nosuid,nodev,noexec proc "$ROOT/proc"
/usr/sbin/pivot_root "$ROOT" "$ROOT/oldroot"
cd /
/usr/bin/umount -l /oldroot
exec /usr/bin/unshare --user --map-user=1000 --map-group=1000 /usr/bin/node --input-type=commonjs -e "$INNER"
`;
const inner = String.raw`
const fs = require('node:fs'), net = require('node:net'), cp = require('node:child_process');
(async () => {
  if (process.getuid() !== 1000 || process.getgid() !== 1000) throw Error('Not running as mapped non-root UID/GID');
  try { fs.readFileSync(process.env.PROBE_SECRET); throw Error('Host file was readable'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  await new Promise((resolve, reject) => {
    const s = net.createConnection(process.env.PROBE_SOCKET);
    s.on('connect', () => { s.destroy(); reject(Error('Host pathname socket was reachable')); });
    s.on('error', e => e.code === 'ENOENT' ? resolve() : reject(e));
  });
  fs.mkdirSync('/tmp/home');
  const env = { HOME:'/tmp/home', PATH:'/usr/bin:/bin', LANG:'C.UTF-8', LD_LIBRARY_PATH:'/runtime/usr/lib/x86_64-linux-gnu:/runtime/lib/x86_64-linux-gnu:/runtime/usr/lib/chromium:/runtime/usr/lib/x86_64-linux-gnu/pulseaudio' };
  const r = cp.spawnSync('/runtime/usr/lib/chromium/chromium', ['--headless','--disable-gpu','--disable-dev-shm-usage','--user-data-dir=/tmp/home/profile','--dump-dom','data:text/html,<title>isolated</title><p>ok</p>'], { env, encoding:'utf8', timeout:20000, maxBuffer:4*1024*1024 });
  if (r.error || r.status !== 0 || !r.stdout.includes('<title>isolated</title>') || !r.stdout.includes('<p>ok</p>')) throw Error('Chromium render failed: '+(r.error || r.status)+'; stderr tail: '+(r.stderr || '').slice(-3000));
  console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),hostFile:'ENOENT',hostPathSocket:'ENOENT',chromiumStatus:r.status,dom:r.stdout.trim()}));
})().catch(e => { console.error(e.stack); process.exitCode=1; });`;
try {
  dir = mkdtempSync('/tmp/dsh-browser-isolation-');
  root = join(dir, 'root'); secret = join(dir, 'secret'); socketPath = join(dir, 'socket');
  mkdirSync(root); writeFileSync(secret, 'self-created probe secret');
  server = net.createServer(c => {
    connections.add(c);
    c.once('close', () => connections.delete(c));
    c.on('error', () => {});
    c.end('self-created probe socket');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  // Positive control: the socket genuinely exists and is connectable outside.
  await new Promise((resolve, reject) => { const c = net.createConnection(socketPath); c.once('connect', () => { c.destroy(); resolve(); }); c.once('error', reject); });
  for (const ns of ['user','mnt','pid','net']) parentNs.push(openSync(`/proc/self/ns/${ns}`, 'r'));
  const env = { PATH:'/usr/sbin:/usr/bin:/sbin:/bin', LANG:'C.UTF-8', ROOT:root, RUNTIME:runtime, NODE_BIN:nodeBin, ATOMIC:atomic, PROBE_SECRET:secret, PROBE_SOCKET:socketPath, INNER:inner, LD_LIBRARY_PATH:'/extra:/runtime/usr/lib/x86_64-linux-gnu:/runtime/lib/x86_64-linux-gnu' };
  // Pass only verified parent namespace descriptors; the launcher closes them before mounting.
  child = spawn('/usr/bin/unshare', ['--map-root-user','--mount','--pid','--net','--fork','--kill-child','/bin/bash','-c',launcher], { env, stdio:['inherit','inherit','inherit',...parentNs], detached:true });
  for (const fd of parentNs.splice(0)) closeSync(fd);
  const terminate = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  process.once('SIGINT', terminate); process.once('SIGTERM', terminate);
  const timer = setTimeout(terminate, 35000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal})); }); }
  finally { clearTimeout(timer); process.off('SIGINT', terminate); process.off('SIGTERM', terminate); }
  if (status.code !== 0) throw Error(`Isolation probe failed: code=${status.code}, signal=${status.signal}`);
} catch (e) { console.error(e.stack); process.exitCode = 1; }
finally {
  for (const fd of parentNs) { try { closeSync(fd); } catch (e) { console.error('Namespace descriptor cleanup:', e.message); process.exitCode = 1; } }
  if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  for (const connection of connections) connection.destroy();
  if (server?.listening) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { console.error('Socket server cleanup timed out'); process.exitCode = 1; resolve(); }, 1000);
      try { server.close(() => { clearTimeout(timer); resolve(); }); }
      catch (e) { clearTimeout(timer); console.error('Socket server cleanup:', e.message); process.exitCode = 1; resolve(); }
    });
  }
  if (dir) { try { rmSync(dir, { recursive:true, force:true }); } catch (e) { console.error('Temporary directory cleanup:', e.message); process.exitCode = 1; } }
}
