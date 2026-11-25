'use strict';

/**
 * Committed regression suite for the Venmo client. Runs against the compiled
 * output so it exercises exactly what n8n loads: `npm test` builds first.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
	VenmoClient,
	VenmoApiError,
	createClientFromCredentials,
} = require('../dist/nodes/Venmo/VenmoClient');

const API = 'https://api.venmo.com/v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function jsonResponse(body, statusCode = 200, headers = {}) {
	return { statusCode, headers, body: JSON.stringify(body) };
}

/** Minimal n8n context: getCredentials + helpers.httpRequest. */
function credentialContext(credentials, request = async () => jsonResponse({ access_token: 'A' })) {
	return { getCredentials: async () => credentials, helpers: { httpRequest: request } };
}

// Tokens are cached per device+account, so every test needs its own device id.
let deviceSequence = 0;

function client(options, request) {
	deviceSequence += 1;
	return new VenmoClient({ deviceId: `test-device-${deviceSequence}`, request, ...options });
}

test('refresh grant posts the form fields and app headers', async () => {
	const calls = [];
	const subject = client(
		{ refreshToken: 'R1' },
		async (options) => {
			calls.push(options);
			return jsonResponse({ access_token: 'A2', refresh_token: 'R2' });
		},
	);

	const result = await subject.refreshAccessToken();

	assert.equal(result.accessToken, 'A2');
	assert.equal(result.refreshToken, 'R2', 'a rotated refresh token is kept');
	assert.equal(calls.length, 1);

	const call = calls[0];
	assert.equal(call.method, 'POST');
	assert.equal(call.url, `${API}/oauth/access_token`);
	assert.match(call.headers['Content-Type'], /application\/x-www-form-urlencoded/);
	assert.equal(call.headers['Venmo-Client-Id'], '4');
	assert.equal(typeof call.body, 'string');

	const form = new URLSearchParams(call.body);
	assert.equal(form.get('grant_type'), 'refresh_token');
	assert.equal(form.get('refresh_token'), 'R1');
	assert.equal(form.get('client_id'), '4');
	assert.equal(form.has('phone_email_or_username'), false, 'the login field must never be sent');
});

test('a refresh-only client renews without touching password sign-in', async () => {
	const calls = [];
	const subject = client(
		{ refreshToken: 'R1' },
		async (options) => {
			calls.push(options);
			return jsonResponse({ access_token: 'A9' });
		},
	);

	assert.equal(await subject.ensureToken(), 'A9');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${API}/oauth/access_token`);
});

test('a GET that 401s renews once and retries with the new token', async () => {
	const calls = [];
	const subject = client(
		{ accessToken: 'OLD', refreshToken: 'R1' },
		async (options) => {
			calls.push(options);
			if (options.url.includes('/oauth/access_token')) {
				return jsonResponse({ access_token: 'NEW' });
			}
			if (options.headers.Authorization === 'Bearer OLD') {
				return jsonResponse({ error: { code: 261, message: 'bad token' } }, 401);
			}
			return jsonResponse({ user: { id: '1' }, balance: '1.00' });
		},
	);

	const account = await subject.getAccount();

	assert.equal(account.user.id, '1');
	assert.equal(calls.length, 3, 'GET, refresh, GET retry');
	assert.equal(calls[1].url, `${API}/oauth/access_token`);
	assert.equal(calls[2].headers.Authorization, 'Bearer NEW');
});

test('a POST that 401s is never retried', async () => {
	const calls = [];
	const subject = client(
		{ accessToken: 'T', refreshToken: 'R' },
		async (options) => {
			calls.push(options);
			return jsonResponse({ error: { code: 261, message: 'bad token' } }, 401);
		},
	);

	await assert.rejects(
		() => subject.apiRequest('POST', '/payments', { body: { amount: -1 } }),
		(error) => error instanceof VenmoApiError && error.venmoCode === 261,
	);

	assert.equal(calls.length, 1, 'a retried payment could move money twice');
});

test('an Access Token credential with no real token is rejected by name', async () => {
	const missing = (error) =>
		error instanceof VenmoApiError &&
		/neither an Access Token nor a Refresh Token/.test(error.message) &&
		!/username\/password configured/.test(error.message);

	await assert.rejects(
		() => createClientFromCredentials(credentialContext({ authMethod: 'accessToken', accessToken: '', refreshToken: '' })),
		missing,
	);
	await assert.rejects(
		() => createClientFromCredentials(credentialContext({ authMethod: 'accessToken', accessToken: '  ', refreshToken: ' ' })),
		missing,
		'whitespace-only fields count as missing',
	);
});

test('either token alone is a valid credential', async () => {
	const refreshOnly = await createClientFromCredentials(
		credentialContext({ authMethod: 'accessToken', accessToken: '', refreshToken: 'R', deviceId: 'd' }),
	);
	assert.equal(await refreshOnly.ensureToken(), 'A');

	const accessOnly = await createClientFromCredentials(
		credentialContext({ authMethod: 'accessToken', accessToken: 'T', deviceId: 'd' }),
	);
	assert.equal(await accessOnly.ensureToken(), 'T');

	const withPassword = await createClientFromCredentials(
		credentialContext({ authMethod: 'password', username: 'u', password: 'p', deviceId: 'd' }),
	);
	assert.ok(withPassword instanceof VenmoClient);
});

test('send payment carries a uuid that a retry reuses', async () => {
	const bodies = [];
	const send = (options) =>
		client({ accessToken: 'T' }, async (requestOptions) => {
			if (requestOptions.method === 'GET') {
				return jsonResponse({ data: [{ id: '1111111111111111111', type: 'balance' }] });
			}
			bodies.push(JSON.parse(requestOptions.body));
			return jsonResponse({ payment: { id: '9' } });
		}).sendPayment({ target: 'friend@example.com', amount: 5, note: 'Coffee', ...options });

	const retryKey = 'exec-42:Send Venmo:0';
	await send({ idempotencyKey: retryKey });
	await send({ idempotencyKey: retryKey });
	await send({});
	await send({});

	assert.equal(bodies.length, 4);
	bodies.forEach((body) => assert.match(body.uuid, UUID_PATTERN));
	assert.equal(bodies[0].uuid, bodies[1].uuid, 'a retried payment must reuse its uuid');
	assert.notEqual(bodies[0].uuid, bodies[2].uuid, 'a fresh send gets a fresh uuid');
	assert.notEqual(bodies[2].uuid, bodies[3].uuid, 'two separate sends never share a uuid');
	assert.equal(bodies[0].amount, 5);
	assert.equal(bodies[0].funding_source_id, '1111111111111111111');
});

test('request payment sends the same uuid treatment, with a negative amount', async () => {
	const bodies = [];
	const request = (options) =>
		client({ accessToken: 'T' }, async (requestOptions) => {
			bodies.push(JSON.parse(requestOptions.body));
			return jsonResponse({ payment: { id: '10' } });
		}).requestPayment({ target: 'friend@example.com', amount: 7, note: 'Split', ...options });

	await request({ idempotencyKey: 'invoice-9' });
	await request({ idempotencyKey: 'invoice-9' });
	await request({});

	assert.equal(bodies.length, 3);
	bodies.forEach((body) => assert.match(body.uuid, UUID_PATTERN));
	assert.equal(bodies[0].uuid, bodies[1].uuid, 'a retried request reuses its uuid');
	assert.notEqual(bodies[0].uuid, bodies[2].uuid, 'a fresh request gets a fresh uuid');
	assert.equal(bodies[0].amount, -7, 'Venmo charges the requested amount as negative');
	assert.equal(bodies[0].email, 'friend@example.com');
});

test('login is form-encoded and password sign-in explains the firewall block', async () => {
	const calls = [];
	const subject = client(
		{ username: 'me@example.com', password: 'pw' },
		async (options) => {
			calls.push(options);
			return jsonResponse({ error: { message: 'Additional authentication is required', code: 81109 } }, 401, {
				'venmo-otp-secret': 'S1',
			});
		},
	);

	const login = await subject.login();

	assert.equal(login.needsTwoFactor, true);
	assert.equal(login.otpSecret, 'S1');
	const form = new URLSearchParams(calls[0].body);
	assert.equal(form.get('phone_email_or_username'), 'me@example.com');
	assert.equal(form.get('client_id'), '4');
	assert.match(calls[0].headers['Content-Type'], /x-www-form-urlencoded/);

	const blocked = client({ username: 'u', password: 'p' }, async () => ({
		statusCode: 403,
		headers: {},
		body: '<html><head><title>403 Forbidden</title></head></html>',
	}));

	await assert.rejects(
		() => blocked.login(),
		(error) => /firewall/.test(error.message) && /phone_email_or_username/.test(error.message) && !/v_id/.test(error.message),
	);
});
