import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import type { IExecuteFunctions } from 'n8n-workflow';

import { VenmoApiError, VenmoTwoFactorRequiredError } from './VenmoClient';

const CODE_HINTS: Record<number, string> = {
	261: 'The access token is not valid. Run Venmo Sign-In, or switch the credential to Email & Password.',
	262: 'This access token was revoked (signed out). Run Venmo Sign-In for a new one.',
	81109: 'Venmo wants a two-factor code for this device. Use the Venmo Sign-In node.',
	81110: 'The two-factor code expired. Run Venmo Sign-In in Start mode again for a fresh code.',
	13006: 'Not enough balance in the selected funding source to send this payment.',
	2901: 'There is no pending payment with that ID to update.',
	2905: 'There is no pending payment with that ID to update.',
	2907: 'A reminder was already sent for this payment.',
};

export function describeVenmoCode(code?: number): string | undefined {
	if (!code) return undefined;
	return CODE_HINTS[code];
}

/** Convert client errors into n8n errors with an actionable hint. */
export function toNodeError(ctx: IExecuteFunctions, error: unknown): Error {
	if (error instanceof VenmoTwoFactorRequiredError) {
		return new NodeOperationError(ctx.getNode(), error.message, {
			description:
				'Open the Venmo Sign-In node, run it in Start mode (Venmo texts you a code), then run Complete mode with that code. Paste the returned access token into the Venmo API credential, or keep Email & Password so the token is refreshed automatically.',
		});
	}

	if (error instanceof VenmoApiError) {
		const description = describeVenmoCode(error.venmoCode);
		const payload: Record<string, string> = { message: error.message };
		if (error.statusCode) payload.httpCode = String(error.statusCode);
		return new NodeApiError(ctx.getNode(), payload, description ? { description } : undefined);
	}

	if (error instanceof Error) return error;

	return new NodeOperationError(ctx.getNode(), String(error));
}
