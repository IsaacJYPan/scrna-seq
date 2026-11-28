'use strict';

const passwordPolicy = require('./passwordPolicy');

function validateSignupBody(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required.' };
  if (!displayName || displayName.length > 200) return { error: 'Display name must be between 1 and 200 characters.' };
  const passwordResult = passwordPolicy.validateNewPassword(password, { email, displayName });
  if (passwordResult.error) return passwordResult;
  return { email, password, displayName };
}

function validateLoginBody(body) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'A valid email is required.' };
  if (!password) return { error: 'Password is required.' };
  if (password.length > 1024) return { error: 'Password must be at most 1024 characters.' };
  return { email, password };
}

function validatePasswordChangeBody(body, user) {
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  if (!currentPassword) return { error: 'Current password is required.' };
  if (currentPassword.length > 1024) return { error: 'Current password must be at most 1024 characters.' };
  if (currentPassword === newPassword) return { error: 'New password must be different from the current password.' };
  const passwordResult = passwordPolicy.validateNewPassword(newPassword, user);
  if (passwordResult.error) return passwordResult;
  return { currentPassword, newPassword };
}

function publicAuthUser(user) {
  return {
    id: Number(user.id),
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

module.exports = { validateSignupBody, validateLoginBody, validatePasswordChangeBody, publicAuthUser };
