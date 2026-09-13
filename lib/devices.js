/* uventoy local device scan — sysfs based, zero dependencies.
 *
 * Two sources (as specified):
 *  1) MMC/SD  : /sys/device/platform/externdevice/mmc_host/mmc* /mmc* /dev
 *                holds "major:minor" -> resolved via the dev file
 *                under each entry of /sys/block, then info is read from /sys/block/<name>.
 *                card "type" file: SD = external SD, MMC = internal storage.
 *                SDIO devices (wifi etc.) are skipped.
 *  2) USB      : /sys/block/sd* where the block kind is "disk"
 *                (uevent DEVTYPE=disk, no "partition" marker),
 *                and the device is removable (removable == 1).
 *
 * Env overrides (for tests): WEBX_SYSFS, WEBX_PROC_MOUNTS
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SYSFS = () => process.env.WEBX_SYSFS || '/sys';
const PROC_MOUNTS = () => process.env.WEBX_PROC_MOUNTS || '/proc/mounts';

function rd(f) { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function kids(p) { try { return fs.readdirSync(p); } catch { return []; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function fmtSize(sectors) {
  const b = (parseInt(sectors, 10) || 0) * 512;
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}

// major:minor -> block name (top-level and nested partitions)
function buildDevMap(root) {
  const m = new Map();
  for (const n of kids(path.join(root, 'block'))) {
    const top = path.join(root, 'block', n);
    if (!isDir(top)) continue;
    const d = rd(path.join(top, 'dev'));
    if (d && !m.has(d)) m.set(d, n);
    for (const k of kids(top)) {
      const dd = rd(path.join(top, k, 'dev'));
      if (dd && !m.has(dd)) m.set(dd, k);
    }
  }
  return m;
}

// locate /sys/block dir of a block name (top-level or nested mmcblkXpY)
function findBlockDir(root, name) {
  const top = path.join(root, 'block', name);
  if (isDir(top)) return top;
  for (const n of kids(path.join(root, 'block'))) {
    const c = path.join(root, 'block', n, name);
    if (isDir(c)) return c;
  }
  return null;
}

function blockInfo(root, name) {
  const dir = findBlockDir(root, name);
  if (!dir) return null;
  return {
    dir,
    size: fmtSize(rd(path.join(dir, 'size'))),
    removable: rd(path.join(dir, 'removable')),
    isPartition: exists(path.join(dir, 'partition')),
  };
}

function ueventDevType(dir) {
  const u = rd(path.join(dir, 'uevent'));
  if (!u) return null;
  const m = u.match(/^DEVTYPE=(.+)$/m);
  return m ? m[1].trim() : null;
}

// system disk? any of its nodes mounted on core Android/Linux paths
const SYS_MOUNTS = new Set(['/', '/data', '/system', '/vendor', '/product', '/system_ext', '/odm']);
function isSystemDisk(name) {
  let txt = '';
  try { txt = fs.readFileSync(PROC_MOUNTS(), 'utf8'); } catch { return false; }
  for (const line of txt.split('\n')) {
    const [src, mp] = line.split(/\s+/);
    if (!src || !mp || !SYS_MOUNTS.has(mp)) continue;
    const base = path.basename(src); // e.g. mmcblk0p2 from /dev/block/mmcblk0p2
    if (base === name || base.startsWith(name)) return true;
  }
  return false;
}

/* ---------- 1) MMC / SD via externdevice mmc_host ---------- */
function scanMmc(root, devMap) {
  const out = [];
  const hostBase = path.join(root, 'device', 'platform', 'externdevice', 'mmc_host');
  for (const host of kids(hostBase)) {
    const hostDir = path.join(hostBase, host);
    if (!isDir(hostDir) || !/^mmc\d+$/.test(host)) continue;
    for (const card of kids(hostDir)) {
      const cardDir = path.join(hostDir, card);
      if (!isDir(cardDir)) continue;
      const type = rd(path.join(cardDir, 'type')); // SD | MMC | SDIO
      if (!type || /^SDIO/i.test(type)) continue;  // skip wifi/combo chips
      const kind = /^MMC/i.test(type) ? 'mmc' : 'sd'; // MMC = internal, SD = external

      // resolve block name: dev file (major:minor) first, standard block/ subdir fallback
      let blk = null;
      const dev = rd(path.join(cardDir, 'dev'));
      if (dev && devMap.has(dev)) blk = devMap.get(dev);
      if (!blk) {
        for (const b of kids(path.join(cardDir, 'block'))) { blk = b; break; }
      }
      if (!blk) continue;
      if (/p\d+$/.test(blk)) continue; // must be whole disk, not a partition name
      const info = blockInfo(root, blk);
      if (!info || info.isPartition) continue;

      const cardName = rd(path.join(cardDir, 'name'));
      const manfid = rd(path.join(cardDir, 'manfid'));
      out.push({
        name: blk,
        size: info.size,
        model: [cardName, manfid].filter(Boolean).join(' ') || (kind === 'mmc' ? 'Internal storage' : 'SD card'),
        kind,
        removable: info.removable === '1',
        system: isSystemDisk(blk),
        source: 'local',
      });
    }
  }
  return out;
}

/* ---------- 2) USB: /sys/block/sd* — kind disk, no partition, removable ---------- */
function scanUsb(root) {
  const out = [];
  for (const n of kids(path.join(root, 'block'))) {
    if (!/^sd[a-z]+$/.test(n)) continue; // whole SCSI disks only (sda, sdb…)
    const dir = path.join(root, 'block', n);
    if (!isDir(dir)) continue;
    if (exists(path.join(dir, 'partition'))) continue; // must not carry a partition name
    const devType = ueventDevType(dir);                 // "disk" for whole disks
    if (devType === 'partition') continue;
    const scsiType = rd(path.join(dir, 'device', 'type')); // "0" = direct-access disk
    const unknown = devType === null && scsiType === null;
    if (!unknown && devType !== 'disk' && scsiType !== '0') continue; // block kind must be disk
    if (rd(path.join(dir, 'removable')) !== '1') continue; // must be removable
    const model = rd(path.join(dir, 'device', 'model'))
      || [rd(path.join(dir, 'device', 'vendor')), rd(path.join(dir, 'device', 'model'))].filter(Boolean).join(' ')
      || 'USB device';
    out.push({
      name: n,
      size: fmtSize(rd(path.join(dir, 'size'))),
      model,
      kind: 'usb',
      removable: true,
      system: isSystemDisk(n),
      source: 'local',
    });
  }
  return out;
}

function listLocalDevices() {
  const root = SYSFS();
  const devMap = buildDevMap(root);
  const list = [...scanMmc(root, devMap), ...scanUsb(root)];
  const seen = new Set();
  return list.filter(d => (seen.has(d.name) ? false : (seen.add(d.name), true)));
}

module.exports = { listLocalDevices, scanMmc, scanUsb, fmtSize };
