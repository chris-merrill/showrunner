// Signed-in avatar + menu, shared by the public pages. Remembered locally so it
// shows instantly; confirmed in the background against Firebase Auth.
const KEY = 'sr-me';
const $acct = document.getElementById('acct');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let auth = null;

function draw(me) {
  if (!$acct) return;
  if (!me) { $acct.innerHTML = ''; return; }
  const initial = esc((me.name || me.email || '?').trim()[0].toUpperCase());
  const pic = me.photo ? ` style="background-image:url('${esc(me.photo)}')"` : '';
  $acct.innerHTML = `<button class="av" id="avb" aria-haspopup="menu" aria-expanded="false" title="${esc(me.email)}"${pic}>${me.photo ? '' : initial}</button>
    <div class="menu" id="mnu" role="menu" hidden>
      <div class="me"><b>${esc(me.name || 'Signed in')}</b><span>${esc(me.email)}</span></div>
      ${me.admin ? '<a href="/admin" role="menuitem">Admin</a>' : ''}
      <a href="/support" role="menuitem">Support</a>
      <button type="button" id="so" role="menuitem">Sign out</button>
    </div>`;
  const btn = document.getElementById('avb'), menu = document.getElementById('mnu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = (e) => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.getElementById('so').onclick = async () => {
    try { localStorage.removeItem(KEY); localStorage.removeItem('sr-admin-feedback'); } catch (_) {}
    draw(null);
    if (auth) { const { signOut } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'); signOut(auth); }
  };
}

try { draw(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch (_) {}

const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
const { getAuth, onAuthStateChanged } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
const app = initializeApp({ apiKey: 'AIzaSyAw9JMZsAq6Skd1gUHqKjcS7yQWpJGnFz4', authDomain: 'showrunner-tools.firebaseapp.com', projectId: 'showrunner-tools', appId: '1:475370655942:web:5f85f28ac490488c4fc7c7' });
auth = getAuth(app);
onAuthStateChanged(auth, async (user) => {
  if (!user) { try { localStorage.removeItem(KEY); } catch (_) {} draw(null); return; }
  let admin = false;
  try {
    const t = await user.getIdToken();
    const r = await fetch(`https://firestore.googleapis.com/v1/projects/showrunner-tools/databases/(default)/documents/admins/${user.uid}`, { headers: { Authorization: `Bearer ${t}` } });
    admin = r.ok;
  } catch (_) {}
  const me = { name: user.displayName, email: user.email, photo: user.photoURL, admin };
  try { localStorage.setItem(KEY, JSON.stringify(me)); } catch (_) {}
  draw(me);
});
