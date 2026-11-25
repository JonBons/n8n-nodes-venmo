'use strict';

/**
 * CLI tests: `main()` accepts an injected client module, so these exercise the
 * send and refresh-token branches without a network call or a real token.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { main } = require('../bin/venmo-cli.js');
const { paymentUuid } = require('../dist/nodes/Venmo/VenmoClient');

/** Capture console output the CLI writes. */
function captureOutput() {
	const out = [];
	const err = [];
	const log = console.log;
	const error = console.error;
	console.log = (...args) => out.push(args.join(' '));
	console.error = (...args) => err.push(args.join(' '));

	return {
		out,
		err,
		restore() {
			console.log = log;
			console.error = error;
		},
	};
}

function fakeSdk(overrides = {}) {
	const calls = [];

	class FakeClient {
		constructor(options) {
			this.options = options;
			calls.push({ call: 'construct', options });
		}

		async refreshAccessToken() {
			calls.push({ call: 'refreshAccessToken' });
			return { accessToken: 'NEW', refreshToken: 'ROTATED' };
		}

		async getAccount() {
			calls.push({ call: 'getAccount' });
			return { user: { id: '1', username: 'me', display_name: 'Me' }, balance: '5.00' };
		}

		async sendPayment(options) {
			calls.push({ call: 'sendPayment', options });
			return { payment: { id: '999' } };
		}
	}

	return {
		sdk: { VenmoClient: FakeClient, deriveDeviceId: () => 'derived-device', paymentUuid, ...overrides },
		calls,
	};
}

async function run(argv, sdk) {
	const output = captureOutput();
	try {
		const code = await main(argv, sdk);
		return { code, stdout: output.out.join('\n'), stderr: output.err.join('\n') };
	} finally {
		output.restore();
	}
}

test('send passes every option to sendPayment and prints id + uuid', async () => {
	const { sdk, calls } = fakeSdk();

	const { code, stdout } = await run(
		[
			'send',
			'--to', 'friend@example.com',
			'--amount', '0.01',
			'--note', 'uuid test',
			'--token', 'T',
			'--funding-source', '1111111111111111111',
			'--idempotency-key', 'venmo-uuid-test-1',
			'--json',
		],
		sdk,
	);

	assert.equal(code, 0);
	const sent = calls.find((call) => call.call === 'sendPayment');
	assert.deepEqual(sent.options, {
		target: 'friend@example.com',
		amount: 0.01,
		note: 'uuid test',
		fundingSourceId: '1111111111111111111',
		idempotencyKey: 'venmo-uuid-test-1',
	});

	const payload = JSON.parse(stdout);
	assert.equal(payload.paymentId, '999');
	assert.equal(payload.idempotencyKey, 'venmo-uuid-test-1');
	assert.equal(payload.uuid, paymentUuid('venmo-uuid-test-1'));
});

test('send with --refresh-token renews first, then sends', async () => {
	const { sdk, calls } = fakeSdk();

	const { code, stdout } = await run(
		['send', '--to', 'friend@example.com', '--amount', '0.01', '--note', 'retry test', '--refresh-token', 'R1', '--json'],
		sdk,
	);

	assert.equal(code, 0);
	assert.deepEqual(
		calls.map((call) => call.call),
		['construct', 'refreshAccessToken', 'sendPayment'],
	);
	assert.equal(calls[0].options.accessToken, undefined);
	assert.equal(calls[0].options.refreshToken, 'R1');

	const payload = JSON.parse(stdout);
	assert.equal(payload.refreshToken, 'ROTATED', 'a rotated refresh token is reported');
	assert.match(payload.uuid, /^[0-9a-f-]{36}$/);
	assert.ok(payload.idempotencyKey, 'a key is generated when none is given');
});

test('account --refresh-token renews and dumps the account', async () => {
	const { sdk, calls } = fakeSdk();

	const { code, stdout } = await run(['account', '--refresh-token', 'R1', '--json'], sdk);

	assert.equal(code, 0);
	assert.deepEqual(
		calls.map((call) => call.call),
		['construct', 'refreshAccessToken', 'getAccount'],
	);

	const payload = JSON.parse(stdout);
	assert.equal(payload.accessToken, 'NEW');
	assert.equal(payload.refreshToken, 'ROTATED');
	assert.equal(payload.deviceId, 'derived-device');
	assert.equal(payload.account.user.id, '1');
});

test('send refuses to run without a recipient, note, amount or token', async () => {
	const cases = [
		[['send'], 'Pass --to'],
		[['send', '--to', 'friend@example.com'], 'Pass --note'],
		[['send', '--to', 'friend@example.com', '--note', 'x', '--amount', '0'], 'Pass --amount'],
		[['send', '--to', 'friend@example.com', '--note', 'x', '--amount', '0.01'], 'Pass --token'],
	];

	for (const [argv, expected] of cases) {
		const { sdk, calls } = fakeSdk();
		const { code, stderr } = await run(argv, sdk);

		assert.equal(code, 1, `expected exit 1 for ${argv.join(' ')}`);
		assert.match(stderr, new RegExp(expected));
		assert.equal(calls.length, 0, 'nothing is constructed or sent');
	}
});
