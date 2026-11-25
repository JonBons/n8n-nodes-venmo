/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomUUID } from 'crypto';

/**
 * Unofficial client for Venmo's mobile API (https://api.venmo.com/v1).
 *
 * Venmo has no public API for personal accounts, so this talks to the same
 * endpoints the iOS app uses:
 *
 *   POST /oauth/access_token                      -> access token (password grant, client_id=4)
 *   POST /oauth/access_token (venmo-otp headers)  -> access token after SMS 2FA
 *   POST /oauth/access_token (grant_type=refresh) -> new access token from a refresh token
 *   POST /account/two-factor/token                -> text an OTP to the account phone
 *   GET  /account                                 -> own profile + balance
 *   GET  /users/{id}, /users?query=               -> profiles + search
 *   GET  /users/{id}/friends
 *   GET  /payment-methods
 *   POST /payments                                -> pay (positive amount) or charge (negative)
 *   PUT  /payments/{id}                           -> approve / deny / cancel / remind
 *   GET  /payments, /payments/{id}
 *   GET  /stories/target-or-actor/{id}, /stories/{id}
 *   DELETE /oauth/access_token                    -> revoke the token
 */

export const VENMO_BASE_URL = 'https://api.venmo.com/v1';

/**
 * The Venmo app build this client claims to be, read out of com.venmo 26.27.1:
 * `PayPalSDKNetworkInterceptor` sends `application-id: com.venmo`,
 * `X-Venmo-Android-Version-Name/CODE` and `Venmo-Client-Id`, and `UserAgent` builds
 * `"<manufacturer>/<model>Venmo/<version> Android/<release> "`.
 *
 * Everything that names the app version derives from this, so a bump cannot leave
 * the user agent and the version headers disagreeing.
 */
export const VENMO_APP_VERSION = { name: '26.27.1', code: '9042' } as const;

/** `Venmo-Client-Id: 4` is the Android app; 1 is the old iPhone client. */
export const VENMO_CLIENT_ID = '4';

/** Exact format from com.venmo.modules.models.platform.UserAgent#getFormattedUserAgent. */
export const VENMO_DEFAULT_USER_AGENT = `Google/Pixel 7Venmo/${VENMO_APP_VERSION.name} Android/14 `;

export interface VenmoHttpRequestOptions {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: any;
	json?: boolean;
	returnFullResponse?: boolean;
	ignoreHttpStatusErrors?: boolean;
	timeout?: number;
}

export interface VenmoHttpResponse {
	statusCode?: number;
	status?: number;
	headers?: any;
	body?: any;
}

export type VenmoRequestFn = (options: VenmoHttpRequestOptions) => Promise<VenmoHttpResponse>;

export interface VenmoCredentials {
	authMethod?: 'password' | 'accessToken';
	username?: string;
	password?: string;
	twoFactorCode?: string;
	accessToken?: string;
	refreshToken?: string;
	deviceId?: string;
}

export interface VenmoLoginResult {
	accessToken?: string;
	/** Present when Venmo rotates or issues a refresh token. */
	refreshToken?: string;
	user?: any;
	balance?: number | string;
	needsTwoFactor?: boolean;
	otpSecret?: string;
	message?: string;
}

export interface VenmoClientOptions {
	/** Stable per-device identifier. Venmo binds two-factor challenges and OTP secrets to it. */
	deviceId: string;
	accessToken?: string;
	refreshToken?: string;
	username?: string;
	password?: string;
	twoFactorCode?: string;
	baseUrl?: string;
	/** Override the HTTP layer (n8n passes its request helper here). Falls back to global fetch. */
	request?: VenmoRequestFn;
}

/** Thrown when Venmo wants an SMS code before it will hand out a token. */
export class VenmoTwoFactorRequiredError extends Error {
	constructor(
		message: string,
		public otpSecret?: string,
	) {
		super(message);
		this.name = 'VenmoTwoFactorRequiredError';
	}
}

export class VenmoApiError extends Error {
	constructor(
		message: string,
		public statusCode?: number,
		public venmoCode?: number,
		public errorBody?: any,
	) {
		super(message);
		this.name = 'VenmoApiError';
	}
}

/**
 * Tokens live for the n8n process lifetime, keyed by device + account, so a
 * password-authenticated credential does not hit the login endpoint on every
 * execution (Venmo throttles and starts demanding 2FA when you do).
 */
const tokenCache = new Map<string, string>();

export function clearCachedToken(deviceId: string, username?: string): void {
	tokenCache.delete(cacheKeyFor(deviceId, username));
}

function cacheKeyFor(deviceId: string, username?: string): string {
	return `${deviceId}::${(username ?? '').trim().toLowerCase()}`;
}

/**
 * Deterministic UUID-shaped device id derived from the account.
 *
 * Venmo only skips SMS 2FA for a device it has already seen, so the id has to
 * be identical on every run. Deriving it means the user never has to invent or
 * copy a device id, while leaving the field overridable.
 */
/** UUID-shaped id from a seed: same seed, same id. */
function uuidFromSeed(seed: string): string {
	const h = createHash('sha256').update(seed).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function deriveDeviceId(seed: string): string {
	return uuidFromSeed(`n8n-venmo::${seed.trim().toLowerCase()}`);
}

/**
 * The `uuid` a payment carries. The app sends one per payment; deriving it from an
 * idempotency key means a retry carries the id Venmo already saw.
 */
export function paymentUuid(idempotencyKey?: string): string {
	return idempotencyKey ? uuidFromSeed(`venmo-payment::${idempotencyKey}`) : randomUUID();
}

export interface TwoFactorSummary {
	/** Phone numbers Venmo will text a code to. */
	smsDevices: Array<{ value?: string; deviceType?: string }>;
	/** Security questions / bank checks the account can be verified with instead. */
	questions: string[];
	hasSms: boolean;
}

/**
 * Normalize `GET /account/two-factor/token`, which returns
 * `{ data: { devices: [{ value, device_type }], questions: [...] } }`.
 */
export function summarizeTwoFactorOptions(body: any): TwoFactorSummary {
	const data = body?.data ?? body ?? {};

	const devices: any[] = Array.isArray(data.devices) ? data.devices : [];
	const smsDevices = devices
		.map((device) => ({ value: device?.value, deviceType: device?.device_type }))
		.filter((device) => (device.deviceType ?? 'sms').toLowerCase() === 'sms');

	const rawQuestions: any[] = Array.isArray(data.questions) ? data.questions : [];
	const questions = rawQuestions
		.map((question) => {
			if (typeof question === 'string') return question;
			if (question?.question_type === 'bank') return 'Bank account verification';
			return question?.value || question?.question_type;
		})
		.filter((question): question is string => Boolean(question));

	return { smsDevices, questions, hasSms: smsDevices.length > 0 };
}

/** n8n's helper may hand back an already-parsed body; HTML error pages stay text. */
function parseBody(body: any): any {
	if (typeof body !== 'string') return body ?? {};
	const text = body.trim();
	if (!text) return {};
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Edge/CDN error pages are HTML, and often repeat their message. */
function flattenErrorBody(body: string): string {
	let text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

	// "403 Forbidden 403 Forbidden" -> "403 Forbidden": collapse a repeated second half.
	for (let index = Math.floor(text.length / 2); index >= 4; index--) {
		const head = text.slice(0, index).trimEnd();
		if (head && text.slice(index).trim() === head) {
			text = head;
			break;
		}
	}

	return text.slice(0, 200);
}

function getHeader(headers: any, name: string): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	if (typeof headers.get === 'function') {
		const value = headers.get(name);
		if (value !== undefined && value !== null) return String(value);
	}
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() !== lower) continue;
		const value = headers[key];
		if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
		return value === undefined || value === null ? undefined : String(value);
	}
	return undefined;
}

/** Minimal fetch-based request function, used when no n8n helper is available. */
export const fetchRequest: VenmoRequestFn = async (options) => {
	const response = await fetch(options.url, {
		method: options.method,
		headers: options.headers,
		body:
			options.body === undefined
				? undefined
				: typeof options.body === 'string'
					? options.body
					: JSON.stringify(options.body),
	});
	const text = await response.text();
	let body: any = text;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	} else {
		body = {};
	}
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	return { statusCode: response.status, headers, body };
};

export class VenmoClient {
	private httpRequest: VenmoRequestFn;
	private baseUrl: string;
	private deviceId: string;
	private accessToken?: string;
	private refreshToken?: string;
	private username?: string;
	private password?: string;
	private twoFactorCode?: string;
	private currentToken?: string;
	private myUserId?: string;
	private twoFactorCodeRejected = false;

	constructor(options: VenmoClientOptions) {
		this.deviceId = options.deviceId;
		this.baseUrl = (options.baseUrl || VENMO_BASE_URL).replace(/\/+$/, '');
		this.httpRequest = options.request || fetchRequest;
		this.accessToken = options.accessToken || undefined;
		this.refreshToken = options.refreshToken || undefined;
		this.username = options.username || undefined;
		this.password = options.password || undefined;
		this.twoFactorCode = options.twoFactorCode || undefined;
	}

	get deviceIdValue(): string {
		return this.deviceId;
	}

	// ---------------------------------------------------------------- transport

	private buildUrl(path: string, query?: Record<string, any>): string {
		const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
		if (query) {
			for (const [key, value] of Object.entries(query)) {
				if (value === undefined || value === null || value === '') continue;
				url.searchParams.set(key, String(value));
			}
		}
		return url.toString();
	}

	private baseHeaders(token?: string, extra?: Record<string, string>, withBody = false): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'User-Agent': VENMO_DEFAULT_USER_AGENT,
			'device-id': this.deviceId,
			'X-Venmo-Android-Version-Name': VENMO_APP_VERSION.name,
			'X-Venmo-Android-Version-CODE': VENMO_APP_VERSION.code,
			'Venmo-Client-Id': VENMO_CLIENT_ID,
			'application-id': 'com.venmo',
			...(withBody ? { 'Content-Type': 'application/json' } : {}),
			...(extra || {}),
		};
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}

	private formHeaders(extra?: Record<string, string>): Record<string, string> {
		return this.baseHeaders(undefined, {
			...(extra || {}),
			'Content-Type': 'application/x-www-form-urlencoded',
		});
	}

	/**
	 * The app's token endpoints are `@FormUrlEncoded` + `@Field` (LogInApi,
	 * AuthenticationTokenExchangeApiService), not JSON.
	 */
	private formBody(fields: Record<string, string | undefined>): string {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined && value !== null) params.set(key, value);
		}
		return params.toString();
	}

	private statusOf(response: VenmoHttpResponse): number {
		return response.statusCode ?? response.status ?? 200;
	}

	private venmoErrorOf(body: any): { code?: number; message?: string } | undefined {
		const error = body?.error;
		if (!error || typeof error !== 'object') return undefined;
		return { code: typeof error.code === 'number' ? error.code : undefined, message: error.message };
	}

	/**
	 * Turn a failed HTTP response into an error the user can act on. Venmo answers
	 * some rejections with an HTML page from its edge (no JSON, no Venmo error
	 * code), so the raw status and body have to be interpreted rather than assumed.
	 */
	private httpError(path: string, status: number, body: any): VenmoApiError {
		const venmoError = this.venmoErrorOf(body);

		if (venmoError?.code === 2) {
			return new VenmoApiError(
				'Venmo rejected the app version this client claims (error code 2, "update to the latest version of the app"). Set VENMO_APP_VERSION in VenmoClient.ts to a current app build — the user agent and the version headers both follow it — and retry.',
				status,
				venmoError.code,
				body,
			);
		}

		if (!venmoError) {
			const snippet = typeof body === 'string' ? flattenErrorBody(body) : '';

			const hint =
				status === 403
					? ' Venmo\'s edge firewall rejects any request whose body carries the login field `phone_email_or_username`, before authentication runs. It is not a wrong password, and no device id, user agent or client id changes it — the real app\'s exact headers and body were replayed and still got this 403. Password and SMS sign-in cannot complete from a server. Use Access Token mode: a token works read/write, and a refresh token renews it without this endpoint.'
					: status === 404
						? ' Check the path.'
						: '';

			return new VenmoApiError(
				`Venmo returned HTTP ${status} for ${path}${snippet ? `: ${snippet}.` : '.'}${hint}`,
				status,
				undefined,
				body,
			);
		}

		return new VenmoApiError(venmoError.message || `Venmo returned HTTP ${status}.`, status, venmoError.code, body);
	}

	/**
	 * One API call. GETs are retried once after a token refresh; writes are not,
	 * because a retried POST /payments can move money twice.
	 */
	async apiRequest(
		method: string,
		path: string,
		options: {
			query?: Record<string, any>;
			body?: any;
			auth?: boolean;
			extraHeaders?: Record<string, string>;
		} = {},
	): Promise<any> {
		const auth = options.auth !== false;
		const send = async (token?: string) =>
			this.httpRequest({
				method,
				url: this.buildUrl(path, options.query),
				headers: this.baseHeaders(token, options.extraHeaders, options.body !== undefined),
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				json: false,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: 60000,
			});

		let token: string | undefined;
		if (auth) token = await this.ensureToken();

		let response = await send(token);
		let status = this.statusOf(response);

		if (auth && status === 401 && method.toUpperCase() === 'GET') {
			await this.renewToken(token);
			token = await this.ensureToken();
			response = await send(token);
			status = this.statusOf(response);
		}

		const body = parseBody(response.body);
		const venmoError = this.venmoErrorOf(body);

		if (status >= 400 || venmoError) {
			throw this.httpError(path, status, body);
		}

		return body;
	}

	// ------------------------------------------------------------- authentication

	/**
	 * POST /oauth/access_token with email + password.
	 * Returns `{ needsTwoFactor: true, otpSecret }` instead of throwing when
	 * Venmo challenges the device with an SMS code.
	 */
	async login(): Promise<VenmoLoginResult> {
		if (!this.username || !this.password) {
			throw new VenmoApiError(
				'No Venmo username/password configured, so password sign-in cannot run. Put an access token or refresh token in the credential instead.',
			);
		}

		const response = await this.httpRequest({
			method: 'POST',
			url: this.buildUrl('/oauth/access_token'),
			headers: this.formHeaders(),
			body: this.formBody({
				phone_email_or_username: this.username,
				client_id: VENMO_CLIENT_ID,
				password: this.password,
			}),
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: 60000,
		});

		const status = this.statusOf(response);
		const body = parseBody(response.body);
		const venmoError = this.venmoErrorOf(body);

		if (body?.access_token) {
			return this.acceptLogin(body);
		}

		const otpSecretHeader = getHeader(response.headers, 'venmo-otp-secret');
		const isTwoFactorChallenge =
			venmoError?.code === 81109 ||
			Boolean(otpSecretHeader) ||
			/two[- ]factor|additional authentication/i.test(venmoError?.message ?? '');

		if (isTwoFactorChallenge) {
			const otpSecret = otpSecretHeader;
			const message =
				venmoError?.message || 'Venmo requires two-factor authentication for this device.';

			if (this.twoFactorCode && otpSecret && !this.twoFactorCodeRejected) {
				try {
					return await this.completeTwoFactor(otpSecret, this.twoFactorCode);
				} catch (error) {
					// A saved code is single-use and expires within minutes. A rejection must not
					// fail the whole sign-in: fall through to the 2FA challenge so the caller can
					// request a fresh code instead of seeing a misleading "bad credentials" error.
					const isCodeRejection =
						error instanceof VenmoApiError &&
						(error.venmoCode === 81109 ||
							error.venmoCode === 81110 ||
							[400, 401, 403].includes(error.statusCode ?? 0));

					// This module is a standalone client; the nodes convert these typed errors
					// with toNodeError(), so it reports the rejection instead of wrapping it.
					if (!isCodeRejection) return Promise.reject(error);

					this.twoFactorCodeRejected = true;
					return {
						needsTwoFactor: true,
						otpSecret,
						message: `${error.message} The two-factor code saved in the credential was not accepted (codes expire quickly) — clear that field and use the Venmo Sign-In node for a fresh one.`,
					};
				}
			}

			return { needsTwoFactor: true, otpSecret, message };
		}

		throw this.httpError('/oauth/access_token', status, body);
	}

	/**
	 * POST /oauth/access_token with grant_type=refresh_token. This is the one sign-in
	 * path Venmo's edge does not block, so a single legitimate refresh token keeps a
	 * credential working without email/password or a login field in the body.
	 */
	async refreshAccessToken(): Promise<VenmoLoginResult> {
		if (!this.refreshToken) {
			throw new VenmoApiError('No Venmo refresh token configured. Add one to the credential, or use an access token.');
		}

		const response = await this.httpRequest({
			method: 'POST',
			url: this.buildUrl('/oauth/access_token'),
			headers: this.formHeaders(),
			body: this.formBody({
				grant_type: 'refresh_token',
				refresh_token: this.refreshToken,
				client_id: VENMO_CLIENT_ID,
			}),
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: 60000,
		});

		const status = this.statusOf(response);
		const body = parseBody(response.body);

		if (body?.access_token) {
			// Venmo may rotate the refresh token; keep the newest one for this process.
			if (typeof body.refresh_token === 'string' && body.refresh_token) {
				this.refreshToken = body.refresh_token;
			}
			return this.acceptLogin(body);
		}

		throw this.httpError('/oauth/access_token', status, body);
	}

	private acceptLogin(body: any): VenmoLoginResult {
		const token = body.access_token as string;
		this.currentToken = token;
		tokenCache.set(cacheKeyFor(this.deviceId, this.username), token);
		if (body.user?.id) this.myUserId = String(body.user.id);
		if (typeof body.refresh_token === 'string' && body.refresh_token) {
			this.refreshToken = body.refresh_token;
		}
		return { accessToken: token, refreshToken: this.refreshToken, user: body.user, balance: body.balance };
	}

	/** Ask Venmo to text an OTP for an in-progress 2FA challenge. */
	async sendTwoFactorCode(otpSecret: string, via: 'sms' | 'call' = 'sms'): Promise<any> {
		return this.apiRequest('POST', '/account/two-factor/token', {
			auth: false,
			body: { via },
			extraHeaders: { 'venmo-otp-secret': otpSecret },
		});
	}

	/** Which second factors the account has (SMS number, security questions, ...). */
	async getTwoFactorOptions(otpSecret: string): Promise<any> {
		return this.apiRequest('GET', '/account/two-factor/token', {
			auth: false,
			query: { client_id: VENMO_CLIENT_ID },
			extraHeaders: { 'venmo-otp-secret': otpSecret },
		});
	}

	/**
	 * What this sign-in can actually be verified with. Returns undefined when the
	 * options endpoint itself is unavailable, so callers can still try SMS
	 * instead of failing an account that would have worked.
	 */
	async getTwoFactorSummary(otpSecret: string): Promise<TwoFactorSummary | undefined> {
		let expiredChallenge: unknown;
		try {
			return summarizeTwoFactorOptions(await this.getTwoFactorOptions(otpSecret));
		} catch (error) {
			// An expired challenge is a real answer: let the caller report it.
			if (error instanceof VenmoApiError && (error.venmoCode === 81109 || error.venmoCode === 81110)) {
				expiredChallenge = error;
			}
		}
		if (expiredChallenge) throw expiredChallenge;
		return undefined;
	}

	/** Exchange the SMS code + otp secret for an access token. */
	async completeTwoFactor(otpSecret: string, otpCode: string): Promise<VenmoLoginResult> {
		const response = await this.httpRequest({
			method: 'POST',
			url: this.buildUrl('/oauth/access_token', { client_id: VENMO_CLIENT_ID }),
			headers: this.formHeaders({
				'venmo-otp-secret': otpSecret,
				'venmo-otp': otpCode.trim(),
			}),
			body: this.formBody({
				phone_email_or_username: this.username,
				client_id: VENMO_CLIENT_ID,
				password: this.password,
			}),
			json: false,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			timeout: 60000,
		});

		const status = this.statusOf(response);
		const body = parseBody(response.body);
		const venmoError = this.venmoErrorOf(body);

		if (body?.access_token) return this.acceptLogin(body);

		if (venmoError) {
			throw new VenmoApiError(
				`${venmoError.message || 'That two-factor code was not accepted.'} Start the sign-in again if the code expired.`,
				status,
				venmoError.code,
				body,
			);
		}

		throw this.httpError('/oauth/access_token', status, body);
	}

	async ensureToken(): Promise<string> {
		if (this.currentToken) return this.currentToken;
		if (this.accessToken) {
			this.currentToken = this.accessToken;
			return this.accessToken;
		}

		const cached = tokenCache.get(cacheKeyFor(this.deviceId, this.username));
		if (cached) {
			this.currentToken = cached;
			return cached;
		}

		// A refresh token renews without the login endpoint, which Venmo's edge blocks
		// for any body carrying the password grant's username field.
		if (this.refreshToken) {
			const refreshed = await this.refreshAccessToken();
			return refreshed.accessToken as string;
		}

		const result = await this.login();
		if (result.accessToken) return result.accessToken;

		if (result.needsTwoFactor) {
			const reason = result.message || 'Venmo wants a two-factor code for this device.';
			throw new VenmoTwoFactorRequiredError(
				`${reason} Run the "Venmo Sign-In" node in Start mode to send a code, then in Complete mode with that code, and save the returned access token in the credential.`,
				result.otpSecret,
			);
		}

		throw new VenmoApiError('Venmo sign-in did not return an access token.');
	}

	/**
	 * Replace a rejected access token. A refresh token is preferred because Venmo's
	 * edge blocks the password grant; a configured password stays as a fallback for
	 * networks where the login endpoint still answers.
	 */
	private async renewToken(rejected?: string): Promise<void> {
		if (rejected) clearCachedToken(this.deviceId, this.username);
		this.currentToken = undefined;

		if (this.refreshToken) {
			await this.refreshAccessToken();
			return;
		}

		if (this.username && this.password) {
			this.accessToken = undefined;
			await this.login();
			return;
		}

		throw new VenmoApiError(
			'Venmo rejected the access token and there is no refresh token or password to renew it. Add a Refresh Token to the credential.',
		);
	}

	async logout(): Promise<void> {
		await this.apiRequest('DELETE', '/oauth/access_token');
		tokenCache.delete(cacheKeyFor(this.deviceId, this.username));
		this.currentToken = undefined;
		this.accessToken = undefined;
		this.refreshToken = undefined;
	}

	// --------------------------------------------------------------------- users

	async getAccount(): Promise<any> {
		const body = await this.apiRequest('GET', '/account');
		if (body?.user?.id) this.myUserId = String(body.user.id);
		return body;
	}

	async getMyUserId(): Promise<string> {
		if (this.myUserId) return this.myUserId;
		await this.getAccount();
		if (!this.myUserId) throw new VenmoApiError('Could not determine your Venmo user id from /account.');
		return this.myUserId;
	}

	async getUser(userId: string): Promise<any> {
		return this.apiRequest('GET', `/users/${encodeURIComponent(userId)}`);
	}

	async searchUsers(
		query: string,
		options: { limit?: number; offset?: number; usernameOnly?: boolean } = {},
	): Promise<any> {
		const params: Record<string, any> = {
			query: options.usernameOnly ? query.replace(/^@/, '') : query,
			limit: options.limit ?? 20,
			offset: options.offset ?? 0,
		};
		if (options.usernameOnly) params.type = 'username';
		return this.apiRequest('GET', '/users', { query: params });
	}

	async getFriends(userId?: string, options: { limit?: number; offset?: number } = {}): Promise<any> {
		const id = userId || (await this.getMyUserId());
		return this.apiRequest('GET', `/users/${encodeURIComponent(id)}/friends`, {
			query: { limit: options.limit ?? 50, offset: options.offset ?? 0 },
		});
	}

	async findUserByUsername(username: string): Promise<any | undefined> {
		const body = await this.searchUsers(username, { usernameOnly: true, limit: 20 });
		const results: any[] = body?.data ?? [];
		const wanted = username.replace(/^@/, '').toLowerCase();
		return results.find((user) => String(user?.username ?? '').toLowerCase() === wanted);
	}

	// ------------------------------------------------------------------ payments

	async getPaymentMethods(): Promise<any> {
		return this.apiRequest('GET', '/payment-methods');
	}

	/** Resolve the funding source Venmo would use when none is given. */
	async getDefaultFundingSourceId(): Promise<string> {
		const body = await this.getPaymentMethods();
		const methods: any[] = body?.data ?? [];
		const preferred =
			methods.find((method) => method?.peer_payment_role === 'default') ??
			methods.find((method) => method?.type === 'balance') ??
			methods.find((method) => method?.type === 'bank') ??
			methods[0];

		if (!preferred?.id) {
			throw new VenmoApiError('No Venmo funding source found on this account.');
		}
		// Venmo ids are 19 digits; keep them as strings so JSON does not round them.
		return String(preferred.id);
	}

	private async targetFields(target: string): Promise<Record<string, string>> {
		const value = target.trim();
		if (!value) throw new VenmoApiError('A recipient is required (user id, username, email or phone).');

		if (value.includes('@')) return { email: value };

		const digits = value.replace(/[^\d+]/g, '');
		if (/^\+?\d{10,11}$/.test(digits)) {
			const phone = digits.replace(/^\+/, '');
			return { phone: phone.length === 10 ? `1${phone}` : phone };
		}

		// Venmo user ids are long numeric strings; short numbers are not ids.
		if (/^\d{15,}$/.test(value)) return { user_id: value };

		const user = await this.findUserByUsername(value);
		if (!user?.id) {
			throw new VenmoApiError(`No Venmo user found for "${value}". Check the username, or pass an email/phone number instead.`);
		}
		return { user_id: String(user.id) };
	}

	async sendPayment(options: {
		target: string;
		amount: number;
		note: string;
		audience?: string;
		fundingSourceId?: string;
		idempotencyKey?: string;
	}): Promise<any> {
		const target = await this.targetFields(options.target);
		const fundingSourceId = options.fundingSourceId || (await this.getDefaultFundingSourceId());
		const uuid = paymentUuid(options.idempotencyKey);

		const body = await this.apiRequest('POST', '/payments', {
			body: {
				...target,
				amount: Math.abs(options.amount),
				note: options.note,
				audience: options.audience ?? 'private',
				funding_source_id: String(fundingSourceId),
				uuid,
				metadata: { quasi_cash_disclaimer_viewed: false },
			},
		});
		return this.unwrapPaymentResponse(body);
	}

	async requestPayment(options: {
		target: string;
		amount: number;
		note: string;
		audience?: string;
		idempotencyKey?: string;
	}): Promise<any> {
		const target = await this.targetFields(options.target);
		const uuid = paymentUuid(options.idempotencyKey);
		const body = await this.apiRequest('POST', '/payments', {
			body: {
				...target,
				amount: -Math.abs(options.amount),
				note: options.note,
				audience: options.audience ?? 'private',
				uuid,
				metadata: { quasi_cash_disclaimer_viewed: false },
			},
		});
		return this.unwrapPaymentResponse(body);
	}

	/**
	 * Venmo reports some failures with HTTP 200 and `{ error_code, title, error_msg }`
	 * inside `data`, so both shapes have to be inspected.
	 */
	private unwrapPaymentResponse(body: any): any {
		const data = body?.data;
		if (data && (data.error_code || data.error)) {
			throw new VenmoApiError(
				data.error_msg || data.title || 'Venmo rejected the payment.',
				undefined,
				Number(data.error_code) || undefined,
				data,
			);
		}
		return data ?? body;
	}

	async getPayment(paymentId: string): Promise<any> {
		return this.apiRequest('GET', `/payments/${encodeURIComponent(paymentId)}`);
	}

	async listPayments(
		options: { action?: string; limit?: number; beforeId?: string; actor?: string } = {},
	): Promise<any> {
		const actor = options.actor ?? (await this.getMyUserId());
		return this.apiRequest('GET', '/payments', {
			query: {
				actor,
				action: options.action && options.action !== 'all' ? options.action : undefined,
				limit: options.limit ?? 50,
				before_id: options.beforeId,
			},
		});
	}

	/** approve | deny | cancel | remind */
	async updatePayment(paymentId: string, action: 'approve' | 'deny' | 'cancel' | 'remind'): Promise<any> {
		return this.apiRequest('PUT', `/payments/${encodeURIComponent(paymentId)}`, { body: { action } });
	}

	async getTransaction(transactionId: string): Promise<any> {
		return this.apiRequest('GET', `/stories/${encodeURIComponent(transactionId)}`);
	}

	async getTransactions(
		userId?: string,
		options: { limit?: number; beforeId?: string } = {},
	): Promise<any> {
		const id = userId || (await this.getMyUserId());
		return this.apiRequest('GET', `/stories/target-or-actor/${encodeURIComponent(id)}`, {
			query: {
				limit: Math.min(options.limit ?? 50, 50),
				before_id: options.beforeId,
			},
		});
	}
}

/** Build a client from the `venmoApi` credential (node context). */
export async function createClientFromCredentials(ctx: any): Promise<VenmoClient> {
	const credentials = (await ctx.getCredentials('venmoApi')) as VenmoCredentials;

	const username = (credentials.username || '').trim();
	const deviceId =
		(credentials.deviceId || '').trim() ||
		deriveDeviceId(username || credentials.accessToken || 'n8n-venmo-default');

	const useToken = credentials.authMethod === 'accessToken';
	const accessToken = useToken ? (credentials.accessToken || '').trim() || undefined : undefined;
	const refreshToken = useToken ? (credentials.refreshToken || '').trim() || undefined : undefined;

	// Access Token mode no longer requires a token on the field itself, so that a
	// refresh-only credential can be saved. Catch the empty case here instead of
	// letting it fall through to a password sign-in the user never configured.
	if (useToken && !accessToken && !refreshToken) {
		throw new VenmoApiError(
			'The Venmo credential is set to Access Token mode but has neither an Access Token nor a Refresh Token. Add at least one of them (the refresh token renews itself), or switch Authentication to Email & Password.',
		);
	}

	// Executions expose `httpRequest` with n8n's option object. The credential-test
	// context only exposes the older `request(url, options)` helper, which uses
	// got-style options and throws on non-2xx, so adapt it into the shape the
	// client expects instead of letting a 401 surface as an HTTP error string.
	const httpRequest = typeof ctx?.helpers?.httpRequest === 'function' ? ctx.helpers.httpRequest : undefined;
	const legacyRequest = typeof ctx?.helpers?.request === 'function' ? ctx.helpers.request : undefined;

	let request: ((options: any) => Promise<any>) | undefined;
	if (httpRequest) {
		request = (options) => httpRequest(options);
	} else if (legacyRequest) {
		request = async (options) => {
			const response = await legacyRequest(options.url, {
				method: options.method,
				headers: options.headers,
				body: options.body,
				json: options.json,
				simple: false,
				resolveWithFullResponse: true,
			});
			return { statusCode: response.statusCode, headers: response.headers ?? {}, body: response.body };
		};
	}

	return new VenmoClient({
		deviceId,
		accessToken,
		refreshToken,
		username: username || undefined,
		password: credentials.password || undefined,
		twoFactorCode: credentials.twoFactorCode || undefined,
		request,
	});
}
