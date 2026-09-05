# Easylife Planner

Single-page React planner with Firebase Authentication, Firestore sync, and secure scheduled task reminders.

## Planner improvements

- Saving waits for server data and checks the remote document in a transaction. If another device changed it, the draft is kept and the user can download it before loading the saved version. Failed saves can be retried; closing a page with pending edits prompts the browser. Unsaved drafts are held in memory, so do not force-close the tab before saving or downloading.
- Each week keeps separate routine completion. Copy last week adds unfinished copies while preserving existing entries. Repeating routines start at the selected week. Removing an occurrence skips that week; turning repeating off stops later occurrences. Older schedules without dated history are anchored to the week of their first migration.
- Tasks support due-date, priority and category editing, search, status/category filters, sorting and overdue labels.
- Settings supports display-name editing, password reset and account deletion. Login also offers password reset.

Publish `index.html`, `planner-data.js` and `planner-sync.js` together. Deploy the updated Firestore rules and `deletePlannerAccount` function before releasing account deletion:

```sh
firebase deploy --project easylife-planner --only firestore:rules,functions:deletePlannerAccount
```

The rules require an incrementing revision on planner writes, which rejects writes from older tabs after migration. Refresh older app tabs after deployment. Account deletion requires a password recheck and removes all user subcollections before deleting the Authentication user. A minimal UID-keyed deletion marker remains to prevent still-valid tokens from recreating data; failed cleanup can be retried.

Local checks (Node.js):

```sh
node tests/planner-sync.cjs
node tests/weekly-schedule.cjs
node tests/account-deletion.cjs
```

`tests/browser-smoke.cjs` additionally uses Playwright with installed Microsoft Edge and CDN access. It substitutes an in-memory Firebase fixture; it does not send real email or delete a real account.

## Enable reminders

1. Install the Firebase CLI and log in: `npm install -g firebase-tools` then `firebase login`.
2. In this project, select the existing Firebase project: `firebase use easylife-planner`.
3. Create a [Resend](https://resend.com) account and verify a sending domain. During deployment, set `RESEND_FROM_EMAIL` to, for example, `Easylife Planner <reminders@your-domain.com>`. (The default Resend address is only suitable for early tests.)
4. Set the provider secret without committing it: `firebase functions:secrets:set RESEND_API_KEY`.
5. Install and deploy: `npm --prefix functions install`; `firebase deploy --only functions,firestore:rules`.

Users can then choose email and/or Discord reminders in Settings. The server runs every 15 minutes, dispatches at each user’s selected hour and time zone, and records a delivery lock so a due-date reminder is sent once. Discord webhook URLs and the email-provider key are only used by the server; the Resend secret is never shipped to the browser.

Firebase Functions scheduling requires the project to be on the Blaze plan. Resend’s sending limits and any email costs are governed by the selected Resend plan.
