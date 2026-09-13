/* uventoy - vanilla JS, same V2DServer JSON API as original WebUI */
'use strict';
const $ = id => document.getElementById(id);
const API = '/vtoy/json';

// English-only UI (keeps bundle tiny vs 287KB languages.js)
const T = {
  ready: 'Ready', ok: 'OK', no: 'Cancel', warn: 'Warning', info: 'Info', err: 'Error',
  empty: 'No devices found — plug in a USB drive, then hit refresh.',
  updTip: d => `Safe upgrade of ${d}, ISO files unchanged.\nContinue?`,
  insTip: d => `${d} will be formatted, ALL data lost!\nContinue?`,
  insTip2: d => `Double check: ALL data on ${d} will be lost!\nReally continue?`,
  insOk: 'Congratulations! Ventoy installed successfully.',
  updOk: 'Congratulations! Ventoy updated successfully.',
  clrOk: 'Ventoy has been removed from the device.',
  insFail: 'Install failed. Replug the USB and check log.txt',
  updFail: 'Update failed. Replug the USB and check log.txt',
  clrFail: 'Clear failed. Check log.txt for details.',
  badSpace: 'Invalid value for reserved space',
  big2tb: 'Please select GPT for devices over 2TB',
  busy: 'A task is running, please wait…',
  sysWarn: 'Warning: this looks like a SYSTEM disk — do not flash it!'
};

let token = 'xx', devs = [], partStyle = 0, busy = false, sel = -1;

async function call(o) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.result === 'tokenerror') { toast(T.busy, 1); location.reload(); throw new Error('token'); }
  if (j.result === 'busy') { toast(T.busy, 1); throw new Error('busy'); }
  return j;
}
function toast(msg, isErr) {
  const d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 4200);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function confirmDlg(title, msg) {
  return new Promise(res => {
    $('dlgTitle').textContent = title; $('dlgMsg').textContent = msg;
    $('dlgOk').textContent = T.ok; $('dlgNo').textContent = T.no; $('dlgNo').style.display = '';
    const dlg = $('dlg'); dlg.showModal();
    $('dlgOk').onclick = () => { dlg.close(); res(true); };
    $('dlgNo').onclick = () => { dlg.close(); res(false); };
  });
}
function alertDlg(title, msg) {
  $('dlgTitle').textContent = title; $('dlgMsg').textContent = msg;
  $('dlgOk').textContent = T.ok; $('dlgNo').style.display = 'none';
  const dlg = $('dlg'); dlg.showModal();
  $('dlgOk').onclick = () => dlg.close();
}
function setBar(p) {
  $('bar').style.width = p + '%'; $('pctTxt').textContent = p + '%';
  $('statusTxt').textContent = p === 0 ? T.ready : `Working… ${p}%`;
}
function lockBtns(b) { busy = b; renderSel(false); }
function fullDesc(d) { return `${d.name} [${d.size}] ${d.model || ''}`; }
function kindSuffix(d) {
  let t = d._kind === 'usb' ? ' • USB' : d._kind === 'sd' ? ' • SD' : d._kind === 'mmc' ? ' • MMC' : '';
  if (d._system) t += ' • SYSTEM — do not flash!';
  return t;
}

function fillDevs(prevName) {
  const s = $('devList');
  s.innerHTML = '';
  if (!devs.length) {
    const o = document.createElement('option');
    o.textContent = T.empty;
    o.disabled = true;
    s.appendChild(o);
  }
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = fullDesc(d) + kindSuffix(d);
    o.title = o.textContent;
    s.appendChild(o);
  });
  sel = -1;
  if (prevName) sel = devs.findIndex(d => d.name === prevName);
  if (sel < 0) sel = devs.length ? 0 : -1;
  renderSel(false);
}

function renderSel(warn) {
  const s = $('devList');
  if (sel >= 0) s.value = String(sel);
  const d = devs[sel];
  const info = $('selInfo');
  if (d) {
    info.textContent = fullDesc(d) + kindSuffix(d);
    info.classList.toggle('sys', !!d._system);
  } else {
    info.textContent = devs.length ? '' : T.empty;
    info.classList.remove('sys');
  }
  // no device selected -> Install & Update stay grey
  if (!d || busy) {
    $('installBtn').disabled = true;
    $('cleanBtn').disabled = !!busy;
  } else {
    $('installBtn').disabled = false;
    $('cleanBtn').disabled = false;
  }
  if (!d) {
    $('devVer').textContent = '—'; $('devPart').textContent = '—';
    $('devLock').hidden = true; $('updateBtn').disabled = true;
    return;
  }
  if (d.vtoy_valid > 0) {
    $('devVer').textContent = d.vtoy_ver || '—';
    $('devPart').textContent = d.vtoy_partstyle ? 'GPT' : 'MBR';
    $('devLock').hidden = !d.vtoy_secure_boot;
    setSecure(d.vtoy_secure_boot ? 1 : 0);
    $('updateBtn').disabled = !!busy;
  } else {
    $('devVer').textContent = '—'; $('devPart').textContent = '—';
    $('devLock').hidden = true; $('updateBtn').disabled = true;
  }
  if (warn && d._system) toast(T.sysWarn, 1);
}
function select(i) { sel = i; renderSel(true); }
function setSecure(v) { $('secureBoot').checked = !!v; $('localLock').hidden = !v; }
function setPart(v) {
  partStyle = v;
  $('mbrBtn').classList.toggle('on', v === 0);
  $('gptBtn').classList.toggle('on', v === 1);
  $('localPart').textContent = v ? 'GPT' : 'MBR';
}

async function loadDevs() {
  const prevName = devs[sel] ? devs[sel].name : null;
  const j = await call({ method: 'get_dev_list', alldev: 0, token });
  devs = j.list || [];
  // merge sysfs local scan (MMC/SD + USB) — V2DServer entries win on name clash
  try {
    const r = await fetch('/api/local-devs');
    const lj = await r.json();
    if (lj.ok && Array.isArray(lj.list)) {
      const have = new Set(devs.map(d => d.name));
      for (const l of lj.list) {
        const hit = devs.find(d => d.name === l.name);
        if (hit) { hit._kind = l.kind; hit._system = !!l.system; }
        else if (!have.has(l.name)) {
          devs.push({ name: l.name, size: l.size, model: l.model, vtoy_valid: 0, vtoy_ver: '', vtoy_partstyle: 0, vtoy_secure_boot: 0, _kind: l.kind, _system: !!l.system });
          have.add(l.name);
        }
      }
    }
  } catch {}
  fillDevs(prevName);
}
async function refresh() {
  if (busy) return;
  $('refreshBtn').classList.add('loading');
  try { await call({ method: 'refresh_device', token }); await loadDevs(); }
  finally { $('refreshBtn').classList.remove('loading'); }
}

function reserveBytes() {
  if (!$('preserveCk').checked) return 0;
  const v = ($('preserveVal').value || '').trim();
  if (!/^\d{1,14}$/.test(v) || +v <= 0) { alertDlg(T.err, T.badSpace); throw 0; }
  return $('preserveUnit').value === 'MB' ? (+v) * 1024 * 1024 : (+v) * 1024 * 1024 * 1024;
}
async function poll(op) {
  const j = await call({ method: 'get_percent', token });
  if (j.result === 'success') {
    setBar(j.percent);
    if (j.percent === 100) {
      await call({ method: 'refresh_device', token });
      await loadDevs(); setBar(0); lockBtns(false);
      alertDlg(T.info, op === 1 ? T.insOk : T.updOk);
    } else setTimeout(() => poll(op).catch(e => fail(op, e)), 500);
  } else {
    setBar(0); lockBtns(false);
    alertDlg(T.err, j.result === 'mbr2tb' ? T.big2tb : (j.result === 'reserve_invalid' ? T.badSpace : (op === 1 ? T.insFail : T.updFail)));
  }
}
function fail(op, e) {
  if (e === 0) return;
  setBar(0); lockBtns(false);
  if (String((e && e.message) || '') !== 'busy' && String((e && e.message) || '') !== 'token') alertDlg(T.err, op === 1 ? T.insFail : T.updFail);
}
function curDev() { return (sel >= 0 && sel < devs.length) ? devs[sel] : null; }

async function doInstall() {
  const d = curDev();
  if (!d || busy) return;
  let rs; try { rs = reserveBytes(); } catch { return; }
  if (!await confirmDlg(T.warn, T.insTip(fullDesc(d)))) return;
  if (!await confirmDlg(T.warn, T.insTip2(fullDesc(d)))) return;
  const j = await call({ method: 'install', token, disk: d.name, partstyle: partStyle, secure_boot: $('secureBoot').checked ? 1 : 0, align_4kb: $('align4k').checked ? 1 : 0, reserve_space: String(rs) }).catch(() => null);
  if (!j) return fail(1, new Error('x'));
  if (j.result === 'success') { lockBtns(true); poll(1); }
  else if (j.result === '4kn') alertDlg(T.err, 'Ventoy does not support 4K native devices.');
  else alertDlg(T.err, T.insFail);
}
async function doUpdate() {
  const d = curDev();
  if (!d || busy) return;
  if (!await confirmDlg(T.info, T.updTip(fullDesc(d)))) return;
  const j = await call({ method: 'update', token, disk: d.name, secure_boot: $('secureBoot').checked ? 1 : 0 }).catch(() => null);
  if (!j) return fail(2, new Error('x'));
  if (j.result === 'success') { lockBtns(true); poll(2); } else alertDlg(T.err, T.updFail);
}
async function doClean() {
  const d = curDev();
  if (!d || busy) return;
  if (!await confirmDlg(T.warn, T.insTip(fullDesc(d)))) return;
  if (!await confirmDlg(T.warn, T.insTip2(fullDesc(d)))) return;
  const j = await call({ method: 'clean', token, disk: d.name }).catch(() => null);
  if (j && j.result === 'success') { toast(T.clrOk); await refresh(); } else alertDlg(T.err, T.clrFail);
}

// events
$('devList').onchange = e => select(+e.target.value);
$('refreshBtn').onclick = () => refresh().catch(() => {});
$('mbrBtn').onclick = () => { setPart(0); call({ method: 'sel_partstyle', token, partstyle: 0 }).catch(() => {}); };
$('gptBtn').onclick = () => { setPart(1); call({ method: 'sel_partstyle', token, partstyle: 1 }).catch(() => {}); };
$('preserveCk').onchange = e => { const c = e.target.checked; $('preserveVal').disabled = !c; $('preserveUnit').disabled = !c; };
$('installBtn').onclick = doInstall; $('updateBtn').onclick = doUpdate; $('cleanBtn').onclick = doClean;

function syncThemeIcon() {
  const light = document.documentElement.dataset.th === 'light';
  $('icoSun').style.display = light ? 'none' : '';
  $('icoMoon').style.display = light ? '' : 'none';
}
$('themeBtn').onclick = () => {
  const h = document.documentElement;
  h.dataset.th = h.dataset.th === 'light' ? '' : 'light';
  syncThemeIcon();
};
if (matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.dataset.th = 'light';
syncThemeIcon();

// boot: same sequence as original index.html (buttons stay grey until a device exists)
(async () => {
  try {
    const s = await call({ method: 'sysinfo' });
    token = s.token;
    $('localVer').textContent = s.ventoy_ver || '…';
    $('pkgLine').textContent = 'Ventoy ' + (s.ventoy_ver || '');
    setPart(s.partstyle == 1 ? 1 : 0); setSecure(1);
    await call({ method: 'refresh_device', token });
    await loadDevs();
    if (s.busy) {
      if (s.process_disk) {
        const i = devs.findIndex(d => d.name === s.process_disk);
        if (i >= 0) sel = i;
      }
      lockBtns(true);
      renderSel(false);
      poll(s.process_type === 'install' ? 1 : 2);
    }
  } catch (e) {
    $('selInfo').textContent = T.err + ': cannot reach V2DServer (start ./VentoyWeb.sh first)';
    $('selInfo').classList.add('sys');
    toast(T.err + ': cannot reach V2DServer (start ./VentoyWeb.sh first)', 1);
  }
})();
