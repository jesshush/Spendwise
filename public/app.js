const $ = (id) => document.getElementById(id);
let mode = 'login';

// Switch between the Log in and Sign up tabs
function setMode(m) {
  mode = m;
  $('tab-login').classList.toggle('active', m === 'login');
  $('tab-signup').classList.toggle('active', m === 'signup');
  $('name-row').hidden = m === 'login';
  $('submit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('error').textContent = '';
}
$('tab-login').onclick = () => setMode('login');
$('tab-signup').onclick = () => setMode('signup');

// What you see once logged in
function showHome(name) {
  $('auth').hidden = true;
  $('home').hidden = false;
  $('hello').textContent = `Hi ${name}!`;
}

// Send the form to the server
$('form').onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch('/api/' + mode, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: $('name').value, email: $('email').value, password: $('password').value }),
  });
  const data = await res.json();
  if (!res.ok) return ($('error').textContent = data.error);
  showHome(data.name);
};

$('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
};

// If already logged in, skip straight to home
fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((u) => u && showHome(u.name));