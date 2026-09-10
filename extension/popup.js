// Reads the ESPN login cookies (SWID + espn_s2) and opens the dashboard's Settings with them pre-filled.
// The values travel in the URL fragment (#...), which browsers never send to the server; the dashboard
// page reads them and saves them through its normal, signed-in Settings flow.
const status = document.getElementById('status');
const dash = document.getElementById('dash');
const go = document.getElementById('go');

let creds = null;

chrome.storage.sync.get(['dashboard'], (r) => {
  if (r.dashboard) dash.value = r.dashboard;
});

async function getCookie(name) {
  const all = await chrome.cookies.getAll({ domain: 'espn.com', name });
  const c = all.sort((a, b) => (b.expirationDate || 0) - (a.expirationDate || 0))[0];
  return c ? c.value : '';
}

(async () => {
  const swid = await getCookie('SWID');
  const s2 = await getCookie('espn_s2');
  if (!swid || !s2) {
    status.innerHTML = '<span class="bad">Not signed in to ESPN.</span> Open fantasy.espn.com, sign in, then click this again.';
    return;
  }
  creds = { swid, s2 };
  status.innerHTML = '<span class="ok">ESPN login found.</span> Enter your dashboard address and click Connect.';
  go.disabled = false;
})();

go.onclick = () => {
  let base = dash.value.trim();
  if (!base) return dash.focus();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  base = base.replace(/\/+$/, '');
  chrome.storage.sync.set({ dashboard: base });
  const frag = new URLSearchParams({ swid: creds.swid, espn_s2: creds.s2 }).toString();
  chrome.tabs.create({ url: `${base}/?espn#${frag}` });
  window.close();
};
