#!/usr/bin/env node
'use strict';

/**
 * Venmo API CLI: sign in with the same client the n8n nodes use and dump GET /account,
 * so the API can be proven working before anything is loaded into n8n.
 *
 *   node bin/venmo-cli.js login
 *   VENMO_USERNAME=you@example.com VENMO_PASSWORD=... node bin/venmo-cli.js login --json
 *   node bin/venmo-cli.js account --token <access-token>
 *
 * Run `npm run build` first: this loads the compiled client from dist/.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { randomUUID } = require('crypto');

const USAGE = `
venmo-api - sign in to Venmo and inspect the account

Usage:
  node bin/venmo-cli.js login [options]     Sign in, print the access token, dump /account
  node bin/venmo-cli.js account [options]   Dump /account with an existing access token
  node bin/venmo-cli.js send [options]      Send a payment (use a tiny amount to test the API)
  node bin/venmo-cli.js help

Options:
  --email <value>        Venmo email, phone or username        (env VENMO_USERNAME)
  --password <value>     Venmo password                         (env VENMO_PASSWORD, prompted if omitted)
  --token <value>        Existing access token                  (env VENMO_TOKEN)
  --refresh-token <v>    Refresh token, mints a new access token (env VENMO_REFRESH_TOKEN)
  --otp-secret <value>   Two-factor session secret from an earlier run (env VENMO_OTP_SECRET)
  --code <value>         Two-factor code, when you already have one     (env VENMO_2FA_CODE)
  --device-id <value>    Stable device id sent with every request      (env VENMO_DEVICE_ID)
  --to <value>           Recipient: id, username, email or phone      (env VENMO_TO)
  --amount <value>       Positive dollar amount, e.g. 0.01            (env VENMO_AMOUNT)
  --note <value>         What the payment is for                      (env VENMO_NOTE)
  --funding-source <id>  Funding source id; defaults to balance       (env VENMO_FUNDING_SOURCE_ID)
  --idempotency-key <v>  Reuse on a retry to keep the same uuid       (env VENMO_IDEMPOTENCY_KEY)
  --json                 Print raw JSON on stdout
  --help                 Show this help

Exit codes:
  0  OK
  1  Error
  3  Venmo wants a security question instead of an SMS code (use Access Token mode)

Venmo's edge firewall rejects any login request whose body carries the login field
phone_email_or_username, before authentication runs, so password sign-in fails from
a server with a bare HTTP 403 whatever the device id. Use --token with an access
token, or --refresh-token to renew one; Venmo accepts those for reads and payments.

--refresh-token sends grant_type=refresh_token, the grant the firewall lets through.
If Venmo rotates the refresh token, the new one is printed alongside the account.
`;

function parseArgs(argv) {
	const args = { _: [] };

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			args._.push(arg);
			continue;
		}

		const key = arg.slice(2);
		const equals = key.indexOf('=');
		if (equals !== -1) {
			args[key.slice(0, equals)] = key.slice(equals + 1);
			continue;
		}

		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith('--')) {
			args[key] = next;
			i++;
		} else {
			args[key] = true;
		}
	}

	return args;
}

function stringArg(args, ...names) {
	for (const name of names) {
		const value = args[name];
		if (typeof value === 'string' && value !== '') return value;
	}
	return undefined;
}

function ask(query) {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(query, (answer) => {
			rl.close();
			resolve(String(answer).trim());
		});
	});
}

/** Read a line without echoing it. Falls back to "no input" when stdin is piped. */
function askHidden(query) {
	return new Promise((resolve) => {
		const stdin = process.stdin;
		const stdout = process.stdout;

		if (!stdin.isTTY) {
			resolve('');
			return;
		}

		stdout.write(query);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding('utf8');

		let value = '';
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n' || char === '\u0004') {
					stdin.setRawMode(false);
					stdin.pause();
					stdin.removeListener('data', onData);
					stdout.write('\n');
					resolve(value);
					return;
				}
				if (char === '\u0003') {
					stdout.write('\n');
					process.exit(130);
				}
				if (char === '\u007f' || char === '\b') {
					value = value.slice(0, -1);
					continue;
				}
				if (char >= ' ') value += char;
			}
		};

		stdin.on('data', onData);
	});
}

function loadClientModule() {
	const built = path.join(__dirname, '..', 'dist', 'nodes', 'Venmo', 'VenmoClient.js');
	if (!fs.existsSync(built)) {
		console.error('Compiled client not found. Run `npm run build` first.');
		process.exit(1);
	}
	return require(built);
}

function printPayment(payment, options) {
	const paymentId = payment?.payment?.id ?? payment?.id;

	if (options.json) {
		const payload = {
			paymentId,
			uuid: options.uuid,
			idempotencyKey: options.idempotencyKey,
			payment,
		};
		if (options.refreshToken) payload.refreshToken = options.refreshToken;
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log('');
	console.log(`Sent $${options.amount.toFixed(2)} to ${options.target}`);
	console.log(`Payment ID: ${paymentId ?? '(not returned)'}`);
	console.log(`UUID:       ${options.uuid}`);
	console.log(`Key:        ${options.idempotencyKey}`);
	if (options.fundingSourceId) console.log(`Funding:    ${options.fundingSourceId}`);
	if (options.refreshToken) console.log(`Refresh:    ${options.refreshToken} (rotated)`);
	console.log('');
	console.log(JSON.stringify(payment, null, 2));
}

function printAccount(account, options) {
	if (options.json) {
		const payload = {
			deviceId: options.deviceId,
			accessToken: options.token,
			account,
		};
		if (options.refreshToken) payload.refreshToken = options.refreshToken;
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	const user = account.user || {};
	console.log('');
	console.log(`Signed in as ${user.display_name || user.username || 'unknown'} (${user.id})`);
	console.log(`Username: ${user.username}`);
	console.log(`Phone:    ${user.phone || '-'}`);
	console.log(`Email:    ${user.email || '-'}`);
	console.log(`Balance:  $${account.balance}`);
	console.log(`Friends:  ${user.friends_count}`);
	console.log('');

	if (options.token) {
		console.log('Access token (paste into the n8n "Venmo API" credential in Access Token mode):');
		console.log(options.token);
		console.log('');
	}

	if (options.refreshToken) {
		console.log('Refresh token (keep it — it mints new access tokens without the login endpoint):');
		console.log(options.refreshToken);
		console.log('');
	}

	console.log('GET /account:');
	console.log(JSON.stringify(account, null, 2));
}

/** `sdk` lets tests inject a client; production loads the compiled module. */
async function main(argv = process.argv.slice(2), sdk) {
	const args = parseArgs(argv);
	const command = args._[0] || 'login';

	if (args.help || command === 'help') {
		console.log(USAGE);
		return 0;
	}

	if (!['login', 'account', 'send'].includes(command)) {
		console.error(`Unknown command "${command}".`);
		console.log(USAGE);
		return 1;
	}

	const { VenmoClient, deriveDeviceId, paymentUuid } = sdk || loadClientModule();

	const token = stringArg(args, 'token') || process.env.VENMO_TOKEN;
	const refreshToken = stringArg(args, 'refresh-token') || process.env.VENMO_REFRESH_TOKEN;
	const email =
		stringArg(args, 'email', 'username') ||
		process.env.VENMO_USERNAME ||
		process.env.VENMO_EMAIL;
	const deviceId =
		stringArg(args, 'device-id') ||
		process.env.VENMO_DEVICE_ID ||
		deriveDeviceId(email || token || refreshToken || 'venmo-cli');

	if (command === 'send') {
		const target = stringArg(args, 'to') || process.env.VENMO_TO;
		const note = stringArg(args, 'note') || process.env.VENMO_NOTE;
		const amount = Number(stringArg(args, 'amount') || process.env.VENMO_AMOUNT);
		const fundingSourceId = stringArg(args, 'funding-source') || process.env.VENMO_FUNDING_SOURCE_ID;
		// Without a key this is a new payment; with one the uuid is reproducible.
		const idempotencyKey =
			stringArg(args, 'idempotency-key') || process.env.VENMO_IDEMPOTENCY_KEY || randomUUID();

		if (!target) {
			console.error('Pass --to <user id, username, email or phone>.');
			return 1;
		}
		if (!note) {
			console.error('Pass --note <what the payment is for>.');
			return 1;
		}
		if (!(amount > 0)) {
			console.error('Pass --amount with a positive dollar amount, e.g. --amount 0.01.');
			return 1;
		}
		if (!token && !refreshToken) {
			console.error('Pass --token <access-token> or --refresh-token <refresh-token> to send. Password sign-in is blocked by Venmo.');
			return 1;
		}

		const client = new VenmoClient({ deviceId, accessToken: token, refreshToken });
		const session = refreshToken ? await client.refreshAccessToken() : undefined;
		const payment = await client.sendPayment({ target, amount, note, fundingSourceId, idempotencyKey });

		printPayment(payment, {
			amount,
			target,
			uuid: paymentUuid(idempotencyKey),
			idempotencyKey,
			fundingSourceId,
			refreshToken: session?.refreshToken,
			json: Boolean(args.json),
		});
		return 0;
	}

	// Renew from a refresh token: the one grant Venmo's edge does not filter.
	if (refreshToken) {
		const client = new VenmoClient({ deviceId, refreshToken });
		const session = await client.refreshAccessToken();
		const account = await client.getAccount();
		printAccount(account, {
			token: session.accessToken,
			refreshToken: session.refreshToken,
			deviceId,
			json: Boolean(args.json),
		});
		return 0;
	}

	// Validate an existing token instead of signing in.
	if (token || command === 'account') {
		if (!token) {
			console.error('Pass --token <access-token> (or set VENMO_TOKEN) to dump /account.');
			return 1;
		}

		const client = new VenmoClient({ deviceId, accessToken: token });
		const account = await client.getAccount();
		printAccount(account, { token: undefined, deviceId, json: Boolean(args.json) });
		return 0;
	}

	const username = email || (await ask('Venmo email, phone or username: '));
	if (!username) {
		console.error('A Venmo email, phone or username is required (--email or VENMO_USERNAME).');
		return 1;
	}

	let password = stringArg(args, 'password') || process.env.VENMO_PASSWORD;
	if (!password) password = await askHidden('Venmo password (input hidden): ');
	if (!password) {
		console.error('A password is required (--password or VENMO_PASSWORD).');
		return 1;
	}

	const client = new VenmoClient({ deviceId, username, password });

	const savedSecret = stringArg(args, 'otp-secret') || process.env.VENMO_OTP_SECRET;
	const savedCode = stringArg(args, 'code') || process.env.VENMO_2FA_CODE;

	let session;

	if (savedSecret && savedCode) {
		session = await client.completeTwoFactor(savedSecret, savedCode);
	} else {
		session = await client.login();

		if (session.needsTwoFactor) {
			if (!session.otpSecret) {
				console.error('Venmo wants two-factor authentication but returned no session secret.');
				if (session.message) console.error(session.message);
				return 1;
			}

			const summary = await client.getTwoFactorSummary(session.otpSecret);

			if (summary && !summary.hasSms) {
				console.error('');
				console.error('Venmo is not offering a text-message code for this sign-in.');
				if (summary.questions.length) {
					console.error(`This account is verified with a security question: ${summary.questions.join(', ')}`);
					console.error('That cannot be answered from here. Sign in on a device Venmo already trusts, then use --token / Access Token mode.');
				} else {
					console.error('Venmo returned no SMS destination. Sign in on a device Venmo already trusts, then use --token / Access Token mode.');
				}
				return 3;
			}

			await client.sendTwoFactorCode(session.otpSecret, 'sms');
			const sentTo = summary && summary.smsDevices[0] ? summary.smsDevices[0].value : undefined;
			console.error(`Venmo texted a code to ${sentTo || 'the phone on the account'}.`);

			const code = savedCode || (await ask('Code from the text message: '));
			if (!code) {
				console.error('No two-factor code entered.');
				return 1;
			}

			session = await client.completeTwoFactor(session.otpSecret, code);
		}
	}

	if (!session.accessToken) {
		console.error('Sign-in did not return an access token.');
		return 1;
	}

	const account = await client.getAccount();
	printAccount(account, { token: session.accessToken, deviceId, json: Boolean(args.json) });
	return 0;
}

if (require.main === module) {
	main()
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error('');
			console.error(`Error: ${error.message}`);
			if (error.errorBody && typeof error.errorBody === 'object') {
				console.error(`Venmo response: ${JSON.stringify(error.errorBody)}`);
			}
			process.exit(1);
		});
}

module.exports = { main, parseArgs, USAGE };
