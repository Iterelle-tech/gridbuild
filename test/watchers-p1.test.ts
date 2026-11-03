import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adfToText, jiraWatcher } from '../src/watchers/jira.ts';
import { crashlyticsWatcher, crashSql } from '../src/watchers/crashlytics.ts';
import { fileQueue } from '../src/queue.ts';
import { fakeExec, tempDir } from './fakes.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

interface Sent { url: string; init: RequestInit }

function fakeFetch(answer: (url: string, init: RequestInit) => { status?: number; body: string }) {
  const sent: Sent[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    const a = answer(String(url), init);
    return new Response(a.body, { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, sent };
}

const JIRA = { baseUrl: 'https://example.atlassian.net', email: 'gridbuild@example.com', token: 'secret-token', jql: 'assignee = currentUser()' };

test('jira: searches with /rest/api/3/search/jql, follows nextPageToken, and turns tickets into tasks', async () => {
  const { fetch, sent } = fakeFetch((url) => ({ body: fixture(url.includes('nextPageToken=page-2') ? 'jira-search-page2.json' : 'jira-search-page1.json') }));
  const tasks = await jiraWatcher({ ...JIRA, fetch }).poll();
  assert.deepEqual(tasks.map((t) => t.id), ['jira-APP-7', 'jira-APP-9']);
  const url = new URL(sent[0].url);
  assert.equal(url.pathname, '/rest/api/3/search/jql');
  assert.equal(url.searchParams.get('jql'), 'assignee = currentUser()');
  assert.match(url.searchParams.get('fields') ?? '', /summary,description/);
  assert.equal(new URL(sent[1].url).searchParams.get('nextPageToken'), 'page-2');
  const headers = sent[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${Buffer.from('gridbuild@example.com:secret-token').toString('base64')}`);
  assert.ok(sent[0].init.signal, 'has a timeout');

  const [app7, app9] = tasks;
  assert.equal(app7.title, 'Checkout button does nothing on Android');
  assert.equal(app7.url, 'https://example.atlassian.net/browse/APP-7');
  assert.equal(app7.body, 'Tapping Pay now does nothing.\n\n- Pixel 8, Android 15\n- App 4.2.0\n\n```\nE/Checkout: onPress is undefined\n```\n\nType: Bug · Priority: High · Labels: checkout');
  assert.equal(app9.body, 'Type: Bug');
});

test('jira: posts status comments as ADF with clickable links, and never leaks the token in errors', async () => {
  const { fetch, sent } = fakeFetch((url, init) => (init.method === 'POST' ? { status: 201, body: '{}' } : { status: 401, body: 'Unauthorized' }));
  const w = jiraWatcher({ ...JIRA, fetch });
  await w.notify!({ id: 'jira-APP-7', source: 'jira', ref: 'APP-7', title: '', body: '' }, 'Pull request: https://github.com/example/app/pull/3');
  assert.equal(sent[0].url, 'https://example.atlassian.net/rest/api/3/issue/APP-7/comment');
  const body = JSON.parse(String(sent[0].init.body));
  assert.deepEqual(body.body.content[0].content[1], { type: 'text', text: 'https://github.com/example/app/pull/3', marks: [{ type: 'link', attrs: { href: 'https://github.com/example/app/pull/3' } }] });
  await assert.rejects(w.poll(), (e: Error) => /returned 401/.test(e.message) && !e.message.includes('secret-token'));
});

test('jira: gets one ticket, and a missing one is undefined', async () => {
  const issue = JSON.parse(fixture('jira-search-page1.json')).issues[0];
  const { fetch } = fakeFetch((url) => (url.includes('APP-7') ? { body: JSON.stringify(issue) } : { status: 404, body: '' }));
  const w = jiraWatcher({ ...JIRA, fetch });
  assert.equal((await w.get('APP-7'))?.id, 'jira-APP-7');
  assert.equal(await w.get('APP-404'), undefined);
  assert.equal(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Sam' } }, { type: 'hardBreak' }, { type: 'text', text: 'hi' }] }] }), '@Sam\nhi');
});

const CRASH = { projectId: 'example-app', dataset: 'firebase_crashlytics', tables: ['com_example_app_ANDROID', 'com_example_app_IOS'], lookbackHours: 24 };

test('crashlytics: queries the BigQuery export per table and builds one task per new crash', async () => {
  const { fetch, sent } = fakeFetch((_url, init) => ({ body: fixture(String(init.body).includes('_ANDROID') ? 'bigquery-android.json' : 'bigquery-ios.json') }));
  const exec = fakeExec((cmd) => (cmd === 'gcloud' ? { stdout: 'ya29.fake\n' } : undefined));
  const tasks = await crashlyticsWatcher({ ...CRASH, fetch, exec }).poll();

  assert.equal(sent[0].url, 'https://bigquery.googleapis.com/bigquery/v2/projects/example-app/queries');
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, 'Bearer ya29.fake');
  const req = JSON.parse(String(sent[0].init.body));
  assert.equal(req.useLegacySql, false);
  assert.deepEqual(req.queryParameters[0], { name: 'lookback_hours', parameterType: { type: 'INT64' }, parameterValue: { value: '24' } });
  assert.match(req.query, /FROM `example-app\.firebase_crashlytics\.com_example_app_ANDROID`/);
  assert.match(req.query, /error_type = 'FATAL'/);
  assert.match(req.query, /exceptions, threads/);
  assert.match(JSON.parse(String(sent[1].init.body)).query, /STRUCT\(error_type, blame_frame, error, threads\)/);

  const [android, ios] = tasks;
  assert.equal(android.id, 'crashlytics-8f2c1a9e0b7d4c3a');
  assert.equal(android.title, 'Crash: java.lang.IllegalStateException: Cart is empty');
  for (const part of ['com.example.app on Android', 'Users affected: 12 (31 crashes)', 'App versions: 4.2.0, 4.2.1', 'OS versions: Android 15, Android 14',
    'Blamed frame: com.example.app.checkout.CheckoutScreen.onPay (CheckoutScreen.kt:88)', '  at android.view.View.performClick (View.java:7659)',
    'Caused by: java.lang.NullPointerException: cart.items']) {
    assert.ok(android.body.includes(part), part);
  }
  assert.equal(ios.title, 'Crash: EXC_BREAKPOINT ProfileView.avatarURL.getter');
  assert.match(ios.body, /Crashed: Thread 0 \(SIGTRAP 0\)\n {2}at ProfileView\.avatarURL\.getter \(ProfileView\.swift:41\)/);
});

test('crashlytics: the same crash is never queued twice, even across polls and restarts', async () => {
  const { fetch } = fakeFetch(() => ({ body: fixture('bigquery-android.json') }));
  const w = crashlyticsWatcher({ ...CRASH, tables: ['com_example_app_ANDROID'], accessToken: 'env-token', fetch });
  const dir = tempDir();
  const added = async () => { let n = 0; for (const t of await w.poll()) if (await fileQueue(dir).add(t)) n++; return n; };
  assert.equal(await added(), 1);
  assert.equal(await added(), 0);
});

test('crashlytics: crashes already known are left out inside the query, before its LIMIT', async () => {
  const { fetch, sent } = fakeFetch(() => ({ body: '{"jobComplete":true}' }));
  await crashlyticsWatcher({ ...CRASH, tables: ['com_example_app_IOS'], accessToken: 't', fetch }).poll(new Set(['crashlytics-c0ffee1234', 'github-7']));
  const req = JSON.parse(String(sent[0].init.body));
  const known = req.queryParameters.find((q: { name: string }) => q.name === 'known_ids');
  assert.deepEqual(known.parameterValue.arrayValues, [{ value: 'c0ffee1234' }]);
  assert.deepEqual(known.parameterType, { type: 'ARRAY', arrayType: { type: 'STRING' } });
  const sql: string = req.query;
  assert.ok(sql.indexOf('NOT IN UNNEST(@known_ids)') > 0 && sql.indexOf('NOT IN UNNEST(@known_ids)') < sql.indexOf('LIMIT 20'));
});

test('crashlytics: waits pollMinutes between BigQuery queries', async () => {
  const { fetch, sent } = fakeFetch(() => ({ body: fixture('bigquery-android.json') }));
  const w = crashlyticsWatcher({ ...CRASH, tables: ['com_example_app_ANDROID'], accessToken: 't', pollMinutes: 60, fetch });
  assert.equal((await w.poll()).length, 1);
  assert.deepEqual(await w.poll(), []);
  assert.equal(sent.length, 1);
});

test('crashlytics: rejects unsafe table names, reports BigQuery and token errors, and gets one issue', async () => {
  assert.throws(() => crashlyticsWatcher({ ...CRASH, tables: ['x`; DROP'] }), /not a BigQuery/);
  const noGcloud = crashlyticsWatcher({ ...CRASH, exec: fakeExec(() => ({ code: 127, stderr: 'command not found: gcloud' })) });
  await assert.rejects(noGcloud.poll(), /gcloud auth login.*GOOGLE_OAUTH_ACCESS_TOKEN/);
  const { fetch: denied } = fakeFetch(() => ({ status: 403, body: '{"error":{"message":"Access Denied"}}' }));
  await assert.rejects(crashlyticsWatcher({ ...CRASH, accessToken: 't', fetch: denied }).poll(), /BigQuery returned 403 for com_example_app_ANDROID: .*Access Denied/);
  const { fetch: slow } = fakeFetch(() => ({ body: '{"jobComplete": false}' }));
  await assert.rejects(crashlyticsWatcher({ ...CRASH, accessToken: 't', fetch: slow }).poll(), /did not finish/);

  const { fetch, sent } = fakeFetch((_u, init) => ({ body: String(init.body).includes('_IOS') ? fixture('bigquery-ios.json') : '{"jobComplete":true}' }));
  const task = await crashlyticsWatcher({ ...CRASH, accessToken: 't', fetch }).get('c0ffee1234');
  assert.equal(task?.id, 'crashlytics-c0ffee1234');
  const req = JSON.parse(String(sent[0].init.body));
  assert.deepEqual(req.queryParameters[0].parameterValue, { value: 'c0ffee1234' });
  assert.match(req.query, /issue_id = @issue_id/);
  assert.doesNotMatch(crashSql({ ...CRASH, table: 'com_example_app_IOS', mode: 'one' }), /HAVING/);
});
