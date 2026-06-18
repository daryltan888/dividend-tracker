'use strict';

function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('auth-error').style.display = 'none';
}

async function handleRegister(e) {
  e.preventDefault();
  hideError();

  const name     = document.getElementById('name').value.trim();
  const email    = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const confirm  = document.getElementById('confirm').value;

  if (password.length < 8) return showError('Password must be at least 8 characters.');
  if (password !== confirm) return showError('Passwords do not match.');

  const btn   = document.getElementById('register-btn');
  const label = document.getElementById('register-label');
  const spin  = document.getElementById('register-spin');

  btn.disabled = true;
  label.textContent = 'Creating account…';
  spin.style.display = 'inline-block';

  try {
    const r = await fetch('/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Registration failed.');
    window.location.href = '/login.html';
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    label.textContent = 'Create Account';
    spin.style.display = 'none';
  }
}

document.getElementById('register-form').addEventListener('submit', handleRegister);
