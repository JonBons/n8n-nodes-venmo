import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class VenmoApi implements ICredentialType {
	name = 'venmoApi';

	displayName = 'Venmo API';

	documentationUrl = 'https://github.com/JonBons/n8n-nodes-venmo#credential-venmo-api';

	properties: INodeProperties[] = [
		{
			displayName: 'Authentication',
			name: 'authMethod',
			type: 'options',
			default: 'password',
			options: [
				{
					name: 'Email & Password (Auto Sign-In)',
					value: 'password',
				},
				{
					name: 'Access Token',
					value: 'accessToken',
				},
			],
			description:
				'Email & Password signs in on demand and caches the token. Access Token skips sign-in entirely.',
		},
		{
			displayName: 'Email, Phone or Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			displayOptions: {
				show: {
					authMethod: ['password'],
				},
			},
			description: 'The same value you use to log into the Venmo app',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: {
				show: {
					authMethod: ['password'],
				},
			},
		},
		{
			displayName: 'Two-Factor Code',
			name: 'twoFactorCode',
			type: 'string',
			default: '',
			displayOptions: {
				show: {
					authMethod: ['password'],
				},
			},
			description:
				'Only needed if Venmo texts you a code. Leave empty and use the Venmo Sign-In node instead, which handles the SMS flow.',
		},
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					authMethod: ['accessToken'],
				},
			},
			description:
				'A token from a signed-in Venmo app session, or from the Venmo Sign-In node. Leave empty if you only have a refresh token.',
		},
		{
			displayName: 'Refresh Token',
			name: 'refreshToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			displayOptions: {
				show: {
					authMethod: ['accessToken'],
				},
			},
			description:
				'Optional. Mints new access tokens without the login endpoint, which Venmo blocks from servers. Used when the access token is rejected; Venmo may rotate it, and the newest value stays in memory for this process. Renewal has only been exercised with a bogus token so far, not a real one — keep an access token as well in case renewal fails.',
		},
		{
			displayName: 'Device ID (v_id)',
			name: 'deviceId',
			type: 'string',
			default: '',
			description:
				'Identifies this client and is what two-factor challenges get bound to. Left empty, a stable ID is derived from the account. It does not decide whether sign-in works: Venmo\'s edge firewall rejects the login field itself before any device ID is read, so a v_id cookie will not get past an HTTP 403. Not used in Access Token mode.',
		},
	];
}
