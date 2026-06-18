'use strict';

function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('auth-error').style.display = 'none';
}

async function handleLogin(e) {
  e.preventDefault();
  hideError();

  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const btn   = document.getElementById('login-btn');
  const label = document.getElementById('login-label');
  const spin  = document.getElementById('login-spin');

  btn.disabled = true;
  label.textContent = 'Logging in…';
  spin.style.display = 'inline-block';

  try {
    const r = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Login failed.');
    window.location.href = '/index.html';
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    label.textContent = 'Log In';
    spin.style.display = 'none';
  }
}

document.getElementById('login-form').addEventListener('submit', handleLogin);
