// Username + password accounts via Supabase Auth, plus per-user cloud storage of the app data.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=5da9d5ed';

export const authEnabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Supabase Auth is email-based; usernames map to a placeholder address that is never emailed.
const EMAIL_DOMAIN = 'users.qbstudy.app';
export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;

let client = null;
async function sb() {
  if (!client) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  }
  return client;
}

const toEmail = (username) => `${username.trim().toLowerCase()}@${EMAIL_DOMAIN}`;
export const usernameOf = (user) => user?.user_metadata?.username || user?.email?.split('@')[0] || '';

function friendly(error) {
  const m = error?.message || String(error);
  if (/failed to fetch|network/i.test(m)) return 'Can’t reach the login server — check your internet connection.';
  if (/invalid login credentials/i.test(m)) return 'Wrong username or password.';
  if (/already registered|already exists/i.test(m)) return 'That username is taken.';
  if (/password/i.test(m) && /at least/i.test(m)) return m;
  if (/email not confirmed/i.test(m)) return 'Account not confirmed — turn off “Confirm email” in Supabase (see README).';
  return m;
}

export async function currentUser() {
  const { data } = await (await sb()).auth.getSession();
  return data.session?.user ?? null;
}

export async function signUp(username, password) {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new Error('Username must be 3–24 characters: letters, numbers or _.');
  if (password.length < 6) throw new Error('Password must be at least 6 characters.');
  const { data, error } = await (await sb()).auth.signUp({ email: toEmail(u), password, options: { data: { username: u } } });
  if (error) throw new Error(friendly(error));
  if (!data.session) throw new Error('Account created but not signed in — turn off “Confirm email” in Supabase (see README).');
  return data.user;
}

export async function signIn(username, password) {
  const { data, error } = await (await sb()).auth.signInWithPassword({ email: toEmail(username), password });
  if (error) throw new Error(friendly(error));
  return data.user;
}

export async function signOut() {
  await (await sb()).auth.signOut();
}

export async function changePassword(newPassword) {
  if (newPassword.length < 6) throw new Error('Password must be at least 6 characters.');
  const { error } = await (await sb()).auth.updateUser({ password: newPassword });
  if (error) throw new Error(friendly(error));
}

/* ---------- realtime channels (multiplayer rooms: broadcast + presence, no tables) ---------- */

export async function openChannel(name, config) {
  return (await sb()).channel(name, { config });
}

export async function closeChannel(channel) {
  if (channel) await (await sb()).removeChannel(channel);
}

/* ---------- recovery codes (see supabase/schema.sql) ---------- */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

// 16 random characters (80 bits), shown as XXXX-XXXX-XXXX-XXXX.
export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % 32]).join('');
  return chars.match(/.{4}/g).join('-');
}

const normalizeCode = (code) => String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function setRecoveryCode(code) {
  const { error } = await (await sb()).rpc('set_recovery_code', { p_code: normalizeCode(code) });
  if (error) throw new Error(friendly(error));
}

export async function hasRecoveryCode() {
  const { data, error } = await (await sb()).rpc('has_recovery_code');
  if (error) throw new Error(friendly(error));
  return Boolean(data);
}

// Resets the password with a recovery code, signs in, and returns the replacement code.
export async function resetPassword(username, code, newPassword) {
  const u = username.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new Error('Enter your username.');
  if (normalizeCode(code).length !== 16) throw new Error('Recovery codes look like XXXX-XXXX-XXXX-XXXX.');
  if (newPassword.length < 6) throw new Error('Password must be at least 6 characters.');
  const newCode = generateRecoveryCode();
  const { data, error } = await (await sb()).rpc('reset_password_with_code', {
    p_username: u, p_code: normalizeCode(code), p_new_password: newPassword, p_new_code: normalizeCode(newCode),
  });
  if (error) throw new Error(friendly(error));
  if (!data) throw new Error('That username and recovery code don’t match.');
  const user = await signIn(u, newPassword);
  return { user, newCode };
}

/* ---------- cloud data: one row per user in public.user_data ---------- */

export async function fetchCloud(userId) {
  const { data, error } = await (await sb()).from('user_data').select('data, updated_at').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data; // { data, updated_at } | null
}

export async function pushCloud(userId, payload) {
  const updated_at = new Date().toISOString();
  const { error } = await (await sb()).from('user_data').upsert({ user_id: userId, data: payload, updated_at });
  if (error) throw new Error(error.message);
  return updated_at;
}
