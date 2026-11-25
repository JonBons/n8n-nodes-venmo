'use strict';

/**
 * Credential-test coverage: `VenmoApi.test()` with a stubbed httpRequest, so the
 * Test button's success and failure messages are asserted without a network call.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Venmo } = require('../dist/nodes/Venmo/Venmo.node.js');

// The test lives on the node: n8n wraps a credential-level `test` into a
// declarative testRequest and never calls it (checked on n8n 2.1.4).
const credentialTest = new Venmo().methods.credentialTest.venmoApi;

const ACCOUNT_BODY = {
	user: { id: '1234567890123456789', username: 'buffy', display_name: 'Buffy' },
	balance: '5.00',
};

/** Stub for n8n's helpers.httpRequest, answering /account with the given response. */
function stubHelpers(response) {
	const calls = [];
	const httpRequest = async (options) => {
		calls.push(options);
		return typeof response === 'function' ? response(options) : response;
	};
	return { helpers: { httpRequest }, calls };
}

function tokenCredential(overrides = {}) {
	return {
		data: {
			authMethod: 'accessToken',
			accessToken: 'stub-token',
			refreshToken: '',
			...overrides,
		},
	};
}

test('credential test reports the signed-in account from /account', async () => {
	const { helpers, calls } = stubHelpers({
		statusCode: 200,
		headers: {},
		body: ACCOUNT_BODY,
	});

	const result = await credentialTest.call({ helpers, logger: console }, tokenCredential());

	assert.equal(result.status, 'OK');
	assert.equal(result.message, 'Signed in as @buffy.');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, 'GET');
	assert.match(calls[0].url, /\/account$/);
	assert.equal(calls[0].headers.Authorization, 'Bearer stub-token');
});

test('credential test surfaces a rejected token as an Error', async () => {
	const { helpers } = stubHelpers({
		statusCode: 401,
		headers: {},
		body: { error: { message: 'You did not pass a valid OAuth access token.', code: 261 } },
	});

	const result = await credentialTest.call({ helpers, logger: console }, tokenCredential());

	assert.equal(result.status, 'Error');
	assert.match(result.message, /rejected the access token/i);
	assert.match(result.message, /refresh token/i);
});
