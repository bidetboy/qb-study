// Username + password accounts via Supabase Auth, plus per-user cloud storage of the app data.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

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
