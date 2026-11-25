import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { createClientFromCredentials, VenmoCredentials } from './VenmoClient';
import { testVenmoCredential } from './credentialTest';
import { toNodeError } from './NodeErrors';

const properties: INodeProperties[] = [
	{
		displayName: 'Mode',
		name: 'mode',
		type: 'options',
		options: [
			{
				name: 'Start: Sign In and Send 2FA Code',
				value: 'start',
				description:
					'Signs in with the credential email/password and texts a code if Venmo asks for one. Venmo currently blocks this from servers, so expect it only to report that; use Access Token mode.',
			},
			{
				name: 'Complete: Verify 2FA Code',
				value: 'complete',
				description: 'Exchanges the code Venmo texted you for an access token',
			},
		],
		default: 'start',
	},
	{
		displayName: 'Two-Factor Code',
		name: 'otpCode',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		required: true,
		displayOptions: { show: { mode: ['complete'] } },
		description: 'The code Venmo texted you',
	},
	{
		displayName: 'OTP Secret',
		name: 'otpSecret',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		displayOptions: { show: { mode: ['complete'] } },
		description:
			'Optional. Defaults to the secret saved by the last Start run in this workflow, which is what Venmo ties the code to.',
	},
];

export class VenmoSignIn implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Venmo Sign-In',
		name: 'venmoSignIn',
		icon: { light: 'file:venmo.svg', dark: 'file:venmo.dark.svg' },
		group: ['transform'],
		usableAsTool: true,
		version: 1,
		subtitle: '={{$parameter["mode"]}}',
		description:
			'Sign in to Venmo with email and password, complete SMS two-factor, and get an access token',
		defaults: {
			name: 'Venmo Sign-In',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'venmoApi',
				required: true,
				testedBy: 'venmoApi',
			},
		],
		properties,
	};

	methods = {
		credentialTest: {
			venmoApi: testVenmoCredential,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const mode = this.getNodeParameter('mode', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				const credentials = (await this.getCredentials('venmoApi')) as VenmoCredentials;
				const client = await createClientFromCredentials(this);

				const hasPassword = Boolean(credentials.username && credentials.password);

				if (mode === 'complete') {
					const staticData = this.getWorkflowStaticData('global');
					const otpSecret =
						((this.getNodeParameter('otpSecret', i, '') as string) || '').trim() ||
						String(staticData.venmoOtpSecret ?? '');
					const otpCode = ((this.getNodeParameter('otpCode', i) as string) || '').trim();

					if (!otpSecret) {
						throw new NodeOperationError(
							this.getNode(),
							'No two-factor session found.',
							{
								description:
									'Run this node in Start mode first (Venmo texts a code), then switch to Complete mode and run it again.',
								itemIndex: i,
							},
						);
					}

					if (!otpCode) {
						throw new NodeOperationError(this.getNode(), 'Enter the code Venmo texted you.', {
							itemIndex: i,
						});
					}

					const result = await client.completeTwoFactor(otpSecret, otpCode);
					delete staticData.venmoOtpSecret;

					returnData.push({
						json: {
							status: 'signed_in',
							accessToken: result.accessToken,
							refreshToken: result.refreshToken,
							userId: result.user?.id,
							username: result.user?.username,
							displayName: result.user?.display_name,
							balance: result.balance,
							deviceId: client.deviceIdValue,
							message:
								'Signed in. Paste the access token into the Venmo API credential, and the refresh token too if one was returned, so it renews unattended.',
						},
						pairedItem: { item: i },
					});
					continue;
				}

				// mode === 'start'
				if (!hasPassword) {
					// Token-only credential: just prove the token still works.
					const account = await client.getAccount();
					returnData.push({
						json: {
							status: 'token_valid',
							userId: account?.user?.id,
							username: account?.user?.username,
							balance: account?.balance,
							deviceId: client.deviceIdValue,
							message:
								"This credential's token works. Add a refresh token to the credential so it renews itself — Venmo blocks password sign-in from servers.",
						},
						pairedItem: { item: i },
					});
					continue;
				}

				const login = await client.login();

				if (login.accessToken) {
					returnData.push({
						json: {
							status: 'signed_in',
							accessToken: login.accessToken,
							refreshToken: login.refreshToken,
							userId: login.user?.id,
							username: login.user?.username,
							displayName: login.user?.display_name,
							balance: login.balance,
							deviceId: client.deviceIdValue,
							twoFactorRequired: false,
							message:
								'Venmo signed this device in without a code. Save the access token in the credential, and the refresh token if one was returned.',
						},
						pairedItem: { item: i },
					});
					continue;
				}

				if (login.needsTwoFactor) {
					if (!login.otpSecret) {
						throw new NodeOperationError(
							this.getNode(),
							'Venmo asked for a two-factor code but did not return a session secret.',
							{
								description:
									'Sign in once in the Venmo app on a phone to clear the challenge, or retry. Some accounts must answer a security question instead of an SMS code.',
								itemIndex: i,
							},
						);
					}

					// Ask what Venmo will actually verify with before firing off an SMS.
					const summary = await client.getTwoFactorSummary(login.otpSecret);

					if (summary && !summary.hasSms) {
						throw new NodeOperationError(
							this.getNode(),
							'Venmo is not offering a text-message code for this sign-in.',
							{
								description: summary.questions.length
									? `This account is verified with a security question (${summary.questions.join(', ')}), which cannot be answered from n8n. Switch the credential to Access Token and supply an access token or refresh token.`
									: 'Venmo returned no SMS destination for this sign-in. Supply an access token or refresh token in the credential.',
								itemIndex: i,
							},
						);
					}

					await client.sendTwoFactorCode(login.otpSecret, 'sms');

					const staticData = this.getWorkflowStaticData('global');
					staticData.venmoOtpSecret = login.otpSecret;

					const sentTo = summary?.smsDevices[0]?.value;

					returnData.push({
						json: {
							status: 'two_factor_required',
							twoFactorRequired: true,
							twoFactorMethod: 'sms',
							sentTo,
							otpSecret: login.otpSecret,
							deviceId: client.deviceIdValue,
							notice: login.message,
							message: `Venmo texted a code to ${sentTo ?? 'the phone on the account'}. Switch this node to Complete mode, enter the code, and run it again.`,
						},
						pairedItem: { item: i },
					});
					continue;
				}

				throw new NodeOperationError(this.getNode(), 'Venmo sign-in returned neither a token nor a 2FA challenge.', {
					itemIndex: i,
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw toNodeError(this, error);
			}
		}

		return [returnData];
	}
}
