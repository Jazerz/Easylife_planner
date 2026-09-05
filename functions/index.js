const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { defineSecret, defineString } = require('firebase-functions/params');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

initializeApp();
const db = getFirestore();
const resendApiKey = defineSecret('RESEND_API_KEY');
const resendFromEmail = defineString('RESEND_FROM_EMAIL', { default: 'Easylife Planner <onboarding@resend.dev>' });

function zonedNow(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  } catch {
    return zonedNow('UTC');
  }
}

function reminderDate(today, days) {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isDiscordWebhook(url) {
  return /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\//.test(url || '');
}

async function sendEmail(to, subject, text) {
  if (!resendApiKey.value()) throw new Error('RESEND_API_KEY is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendApiKey.value()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: resendFromEmail.value(), to: [to], subject, text })
  });
  if (!response.ok) throw new Error(`Resend rejected the email (${response.status}).`);
}

async function sendDiscord(webhook, content) {
  if (!isDiscordWebhook(webhook)) throw new Error('The Discord webhook URL is invalid.');
  const response = await fetch(webhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content })
  });
  if (!response.ok) throw new Error(`Discord rejected the webhook (${response.status}).`);
}

async function deliverReminder({ uid, settings, tasks, test = false }) {
  const emailEnabled = Boolean(settings.emailEnabled);
  const discordEnabled = Boolean(settings.discordEnabled);
  if (!emailEnabled && !discordEnabled) throw new Error('Enable email or Discord reminders first.');

  const subject = test ? 'Easylife Planner test reminder' : `Easylife Planner: ${tasks.length} task${tasks.length === 1 ? '' : 's'} due soon`;
  const list = tasks.map(task => `• ${task.name} — due ${task.due}`).join('\n');
  const text = test ? 'Your Easylife Planner reminder connection is working.' : `Don’t forget these unfinished tasks:\n\n${list}`;
  const results = [];
  if (emailEnabled) {
    const user = await getAuth().getUser(uid);
    if (!user.email) throw new Error('This account has no email address.');
    await sendEmail(user.email, subject, text);
    results.push('email');
  }
  if (discordEnabled) {
    await sendDiscord(settings.discordWebhook, `**${subject}**\n${text}`);
    results.push('Discord');
  }
  return results;
}

exports.sendTestReminder = onCall({ secrets: [resendApiKey] }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before sending a test reminder.');
  if ((await db.doc(`users/${request.auth.uid}`).get()).data()?.deleting) throw new HttpsError('failed-precondition', 'Account deletion is in progress.');
  const planner = await db.doc(`users/${request.auth.uid}/planner/main`).get();
  if (!planner.exists) throw new HttpsError('failed-precondition', 'Save your planner settings before sending a test.');
  try {
    const sentTo = await deliverReminder({ uid: request.auth.uid, settings: planner.data().notifications || {}, tasks: [], test: true });
    return { message: `Test reminder sent via ${sentTo.join(' and ')}.` };
  } catch (error) {
    console.error('Test reminder failed', error);
    throw new HttpsError('failed-precondition', error.message);
  }
});

exports.sendDueTaskReminders = onSchedule({ schedule: 'every 15 minutes', timeZone: 'UTC', secrets: [resendApiKey] }, async () => {
  const planners = await db.collectionGroup('planner').get();
  await Promise.all(planners.docs.filter(doc => doc.id === 'main').map(async planner => {
    const data = planner.data();
    const settings = data.notifications || {};
    if (!settings.emailEnabled && !settings.discordEnabled) return;
    const now = zonedNow(settings.timezone || 'UTC');
    if (Number(settings.reminderHour) !== now.hour) return;
    const due = reminderDate(now.date, Number(settings.reminderDays) || 0);
    const tasks = (data.tasks || []).filter(task => !task.done && task.due === due);
    if (!tasks.length) return;
    const uid = planner.ref.parent.parent.id;
    if ((await db.doc(`users/${uid}`).get()).data()?.deleting) return;
    const logRef = planner.ref.collection('reminderLog').doc(`${due}-${settings.reminderDays || 0}`);
    const shouldSend = await db.runTransaction(async transaction => {
      if ((await transaction.get(logRef)).exists) return false;
      transaction.set(logRef, { createdAt: FieldValue.serverTimestamp(), due, taskIds: tasks.map(task => String(task.id)) });
      return true;
    });
    if (!shouldSend) return;
    try {
      await deliverReminder({ uid, settings, tasks });
    } catch (error) {
      await logRef.delete();
      console.error(`Reminder failed for ${uid}`, error);
    }
  }));
});

// Requires a freshly reauthenticated password session. A tombstone prevents old
// browser sessions from recreating data during cleanup or after Auth deletion.
exports.deletePlannerAccount = onCall(async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (Date.now() / 1000 - Number(request.auth.token.auth_time || 0) > 300) {
    throw new HttpsError('failed-precondition', 'Please sign in again before deleting your account.');
  }
  const uid = request.auth.uid;
  const root = db.doc(`users/${uid}`);
  await root.set({ deleting: true });
  try {
    const collections = await root.listCollections();
    for (const collection of collections) await db.recursiveDelete(collection);
    await getAuth().deleteUser(uid);
    return { deleted: true };
  } catch {
    // Keep the tombstone and allow an authenticated retry to finish cleanup.
    throw new HttpsError('internal', 'Deletion could not finish. Please retry.');
  }
});
