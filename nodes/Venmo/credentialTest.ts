import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	INodeCredentialTestResult,
} from 'n8n-workflow';

import { createClientFromCredentials } from './VenmoClient';

/**
 * Powers the credential Test button. Registered through `methods.credentialTest`
 * on each node that uses the credential, because n8n wraps a credential-level
 * `test` into a declarative `testRequest` and never calls it (checked on n8n
 * 2.1.4, where that path fails with "Invalid URL").
 *
 * Builds the client the same way the nodes do, so sign-in, refresh and the
 * empty-token guard are exercised, then reads /account, which needs a token.
 */
export async function testVenmoCredential(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
	try {
		const client = await createClientFromCredentials({
			getCredentials: async () => credential.data,
			helpers: this.helpers,
		});

		const account = await client.getAccount();
		const user = account?.user ?? {};
		const who = user.username
			? `@${user.username}`
			: user.display_name || user.id || 'your Venmo account';

		return { status: 'OK', message: `Signed in as ${who}.` };
	} catch (error) {
		return { status: 'Error', message: error instanceof Error ? error.message : String(error) };
	}
}
