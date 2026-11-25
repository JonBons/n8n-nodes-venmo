import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { createClientFromCredentials, VenmoClient } from './VenmoClient';
import { testVenmoCredential } from './credentialTest';
import { toNodeError } from './NodeErrors';

const showFor = (resource: string, operations: string[]) => ({
	show: { resource: [resource], operation: operations },
});

const resourceProperty: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Account', value: 'account' },
		{ name: 'Payment', value: 'payment' },
		{ name: 'User', value: 'user' },
		{ name: 'Custom API Call', value: 'custom' },
	],
	default: 'payment',
};

const accountProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['account'] } },
		options: [
			{
				name: 'Get Balance',
				value: 'getBalance',
				description: 'Venmo balance of the signed-in account',
				action: 'Get the balance',
			},
			{
				name: 'Get Payment Methods',
				value: 'getPaymentMethods',
				description: 'Bank accounts, cards and the Venmo balance',
				action: 'Get payment methods',
			},
			{
				name: 'Get Profile',
				value: 'getProfile',
				description: 'Own profile, balance and settings',
				action: 'Get the profile',
			},
			{
				name: 'Sign Out',
				value: 'signOut',
				description: 'Revoke the current access token',
				action: 'Sign out',
			},
		],
		default: 'getProfile',
	},
];

const userProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['user'] } },
		options: [
			{
				name: 'Get',
				value: 'getUser',
				action: 'Get a user profile',
			},
			{
				name: 'Get Friends',
				value: 'getFriends',
				action: 'Get a friend list',
			},
			{
				name: 'Search',
				value: 'searchUsers',
				description: 'Find a Venmo user by name, username, email or phone',
				action: 'Search users',
			},
		],
		default: 'searchUsers',
	},
	{
		displayName: 'User ID',
		name: 'userId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: showFor('user', ['getUser']),
		description: 'The numeric Venmo user ID',
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		default: '',
		required: true,
		displayOptions: showFor('user', ['searchUsers']),
		description: 'Name, username, email or phone number to search for',
	},
	{
		displayName: 'Username Only',
		name: 'usernameOnly',
		type: 'boolean',
		default: false,
		displayOptions: showFor('user', ['searchUsers']),
		description: 'Whether to match on the Venmo username instead of the display name',
	},
	{
		displayName: 'User ID',
		name: 'friendsUserId',
		type: 'string',
		default: '',
		displayOptions: showFor('user', ['getFriends']),
		description: 'Whose friends to list. Leave empty for your own friends.',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 3337 },
		default: 50,
		displayOptions: showFor('user', ['searchUsers', 'getFriends']),
		description: 'Max number of results to return',
	},
	{
		displayName: 'Offset',
		name: 'offset',
		type: 'number',
		typeOptions: { minValue: 0 },
		default: 0,
		displayOptions: showFor('user', ['searchUsers', 'getFriends']),
		description: 'Number of results to skip, for paging',
	},
];

const paymentProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['payment'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				action: 'Get a payment',
			},
			{
				name: 'Get Transaction',
				value: 'getTransaction',
				description: 'Any transaction/feed item by its story ID',
				action: 'Get a transaction',
			},
			{
				name: 'List',
				value: 'list',
				action: 'List payments',
			},
			{
				name: 'List Transactions',
				value: 'listTransactions',
				description: 'Feed items where the user is the actor or target',
				action: 'List transactions',
			},
			{
				name: 'Request',
				value: 'request',
				description: 'Send a charge to someone else',
				action: 'Request a payment',
			},
			{
				name: 'Send',
				value: 'send',
				description: 'Pay a user, email address or phone number',
				action: 'Send a payment',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Approve, deny, cancel or remind a pending payment request',
				action: 'Update a payment',
			},
		],
		default: 'send',
	},
	{
		displayName: 'Recipient',
		name: 'target',
		type: 'string',
		default: '',
		required: true,
		displayOptions: showFor('payment', ['send', 'request']),
		description:
			'Venmo user ID, username, email address or US phone number. Usernames are looked up automatically.',
	},
	{
		displayName: 'Amount',
		name: 'amount',
		type: 'number',
		typeOptions: { numberPrecision: 2, minValue: 0.01 },
		default: 0,
		required: true,
		displayOptions: showFor('payment', ['send', 'request']),
		description: 'Dollar amount, always positive. "Request Payment" charges this amount.',
	},
	{
		displayName: 'Note',
		name: 'note',
		type: 'string',
		default: '',
		required: true,
		displayOptions: showFor('payment', ['send', 'request']),
		description: 'What the payment is for. Venmo requires a note.',
	},
	{
		displayName: 'Audience',
		name: 'audience',
		type: 'options',
		options: [
			{ name: 'Private', value: 'private' },
			{ name: 'Friends', value: 'friends' },
			{ name: 'Public', value: 'public' },
		],
		default: 'private',
		displayOptions: showFor('payment', ['send', 'request']),
		description: 'Who can see this payment in the Venmo feed',
	},
	{
		displayName: 'Funding Source ID',
		name: 'fundingSourceId',
		type: 'string',
		default: '',
		displayOptions: showFor('payment', ['send']),
		description:
			'Optional. Payment method ID from "Account: Get Payment Methods". Defaults to your Venmo balance or default method.',
	},
	{
		displayName: 'Idempotency Key',
		name: 'idempotencyKey',
		type: 'string',
		default: '',
		displayOptions: showFor('payment', ['send', 'request']),
		description:
			'Optional. Reused on retries so Venmo sees the same payment. Defaults to the execution, node and item, which survives "Retry On Fail" but not a retry from the Executions list — set a business ID (order, invoice, row ID) when a retry must not create a second payment.',
	},
	{
		displayName: 'Payment ID',
		name: 'paymentId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: showFor('payment', ['get', 'update']),
		description: 'The numeric payment ID',
	},
	{
		displayName: 'Action',
		name: 'paymentAction',
		type: 'options',
		options: [
			{ name: 'Approve', value: 'approve' },
			{ name: 'Deny', value: 'deny' },
			{ name: 'Cancel', value: 'cancel' },
			{ name: 'Send Reminder', value: 'remind' },
		],
		default: 'approve',
		displayOptions: showFor('payment', ['update']),
		description: 'Approve/deny a request you received, or cancel/remind a request you sent',
	},
	{
		displayName: 'Action',
		name: 'listAction',
		type: 'options',
		options: [
			{ name: 'All', value: 'all' },
			{ name: 'Pay', value: 'pay' },
			{ name: 'Charge', value: 'charge' },
		],
		default: 'all',
		displayOptions: showFor('payment', ['list']),
		description: 'Filter by payment action',
	},
	{
		displayName: 'Limit',
		name: 'paymentLimit',
		type: 'number',
		typeOptions: { minValue: 1, maxValue: 50 },
		default: 50,
		displayOptions: showFor('payment', ['list', 'listTransactions']),
		description: 'Max number of results to return',
	},
	{
		displayName: 'Before ID',
		name: 'beforeId',
		type: 'string',
		default: '',
		displayOptions: showFor('payment', ['list', 'listTransactions']),
		description: 'Return items older than this payment/transaction ID, for paging',
	},
	{
		displayName: 'Transaction ID',
		name: 'transactionId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: showFor('payment', ['getTransaction']),
	},
	{
		displayName: 'User ID',
		name: 'transactionsUserId',
		type: 'string',
		default: '',
		displayOptions: showFor('payment', ['listTransactions']),
		description: 'Whose transactions to list. Leave empty for your own.',
	},
];

const customProperties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['custom'] } },
		options: [
			{
				name: 'Make API Request',
				value: 'request',
				description: 'Call any https://api.venmo.com/v1 endpoint with your credentials',
				action: 'Make an API request',
			},
		],
		default: 'request',
	},
	{
		displayName: 'Method',
		name: 'method',
		type: 'options',
		options: [
			{ name: 'GET', value: 'GET' },
			{ name: 'POST', value: 'POST' },
			{ name: 'PUT', value: 'PUT' },
			{ name: 'DELETE', value: 'DELETE' },
		],
		default: 'GET',
		displayOptions: showFor('custom', ['request']),
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		default: '',
		required: true,
		placeholder: '/payments/1234567890/comments',
		displayOptions: showFor('custom', ['request']),
		description: 'Path relative to /v1, starting with a slash',
	},
	{
		displayName: 'Query',
		name: 'query',
		type: 'json',
		default: '',
		displayOptions: showFor('custom', ['request']),
		description: 'Query string parameters as JSON',
	},
	{
		displayName: 'Body',
		name: 'body',
		type: 'json',
		default: '',
		displayOptions: showFor('custom', ['request']),
		description: 'JSON request body',
	},
];

function parseJsonParam(
	ctx: IExecuteFunctions,
	value: unknown,
	label: string,
): IDataObject | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'object') return value as IDataObject;
	try {
		return JSON.parse(String(value)) as IDataObject;
	} catch {
		throw new NodeOperationError(ctx.getNode(), `${label} must be valid JSON.`);
	}
}

/** Venmo wraps most responses in `data`; keep `pagination` when present. */
function unwrapResponse(body: any): IDataObject {
	if (body && typeof body === 'object' && 'data' in body) {
		if ('pagination' in body) return body as IDataObject;
		return (body.data ?? {}) as IDataObject;
	}
	return (body ?? {}) as IDataObject;
}

async function runOperation(
	ctx: IExecuteFunctions,
	client: VenmoClient,
	resource: string,
	operation: string,
	i: number,
): Promise<any> {
	if (resource === 'account') {
		if (operation === 'getProfile') return await client.getAccount();

		if (operation === 'getBalance') {
			const account = await client.getAccount();
			return {
				balance: account?.balance,
				userId: account?.user?.id,
				username: account?.user?.username,
				displayName: account?.user?.display_name,
			};
		}

		if (operation === 'getPaymentMethods') return await client.getPaymentMethods();

		if (operation === 'signOut') {
			await client.logout();
			return { success: true };
		}
	}

	if (resource === 'user') {
		if (operation === 'getUser') {
			const userId = ctx.getNodeParameter('userId', i) as string;
			return await client.getUser(userId);
		}

		if (operation === 'searchUsers') {
			const query = ctx.getNodeParameter('query', i) as string;
			return await client.searchUsers(query, {
				limit: ctx.getNodeParameter('limit', i, 20) as number,
				offset: ctx.getNodeParameter('offset', i, 0) as number,
				usernameOnly: ctx.getNodeParameter('usernameOnly', i, false) as boolean,
			});
		}

		if (operation === 'getFriends') {
			const userId = (ctx.getNodeParameter('friendsUserId', i, '') as string) || undefined;
			return await client.getFriends(userId, {
				limit: ctx.getNodeParameter('limit', i, 50) as number,
				offset: ctx.getNodeParameter('offset', i, 0) as number,
			});
		}
	}

	if (resource === 'payment') {
		if (operation === 'send' || operation === 'request') {
			const target = ctx.getNodeParameter('target', i) as string;
			const amount = ctx.getNodeParameter('amount', i) as number;
			const note = ctx.getNodeParameter('note', i) as string;
			const audience = ctx.getNodeParameter('audience', i, 'private') as string;

			if (!(amount > 0)) {
				throw new NodeOperationError(
					ctx.getNode(),
					'Amount must be greater than 0.',
					{ itemIndex: i },
				);
			}

			// A business id survives a workflow-level retry; the execution-scoped
			// fallback only survives Retry On Fail, which re-runs inside ctx execution.
			const idempotencyKey =
				((ctx.getNodeParameter('idempotencyKey', i, '') as string) || '').trim() ||
				`${ctx.getExecutionId()}:${ctx.getNode().name}:${i}`;

			if (operation === 'send') {
				return await client.sendPayment({
					target,
					amount,
					note,
					audience,
					fundingSourceId: (ctx.getNodeParameter('fundingSourceId', i, '') as string) || undefined,
					idempotencyKey,
				});
			}

			return await client.requestPayment({ target, amount, note, audience, idempotencyKey });
		}

		if (operation === 'get') {
			const paymentId = ctx.getNodeParameter('paymentId', i) as string;
			return await client.getPayment(paymentId);
		}

		if (operation === 'list') {
			return await client.listPayments({
				action: ctx.getNodeParameter('listAction', i, 'all') as string,
				limit: ctx.getNodeParameter('paymentLimit', i, 50) as number,
				beforeId: (ctx.getNodeParameter('beforeId', i, '') as string) || undefined,
			});
		}

		if (operation === 'update') {
			const paymentId = ctx.getNodeParameter('paymentId', i) as string;
			const action = ctx.getNodeParameter('paymentAction', i) as
				| 'approve'
				| 'deny'
				| 'cancel'
				| 'remind';
			return await client.updatePayment(paymentId, action);
		}

		if (operation === 'getTransaction') {
			const transactionId = ctx.getNodeParameter('transactionId', i) as string;
			return await client.getTransaction(transactionId);
		}

		if (operation === 'listTransactions') {
			return await client.getTransactions(
				(ctx.getNodeParameter('transactionsUserId', i, '') as string) || undefined,
				{
					limit: ctx.getNodeParameter('paymentLimit', i, 50) as number,
					beforeId: (ctx.getNodeParameter('beforeId', i, '') as string) || undefined,
				},
			);
		}
	}

	if (resource === 'custom' && operation === 'request') {
		const method = ctx.getNodeParameter('method', i) as string;
		const path = ctx.getNodeParameter('path', i) as string;
		return await client.apiRequest(method, path, {
			query: parseJsonParam(ctx, ctx.getNodeParameter('query', i, ''), 'Query'),
			body: parseJsonParam(ctx, ctx.getNodeParameter('body', i, ''), 'Body'),
		});
	}

	throw new NodeOperationError(
		ctx.getNode(),
		`Unsupported operation "${operation}" for resource "${resource}".`,
		{ itemIndex: i },
	);
}

export class Venmo implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Venmo',
		name: 'venmo',
		icon: { light: 'file:venmo.svg', dark: 'file:venmo.dark.svg' },
		group: ['transform'],
		usableAsTool: true,
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Send and request Venmo payments, look up users and read transactions',
		defaults: {
			name: 'Venmo',
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
		properties: [
			resourceProperty,
			...accountProperties,
			...userProperties,
			...paymentProperties,
			...customProperties,
		],
	};

	methods = {
		credentialTest: {
			venmoApi: testVenmoCredential,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		const client: VenmoClient = await createClientFromCredentials(this);

		for (let i = 0; i < items.length; i++) {
			try {
				const response = await runOperation(this, client, resource, operation, i);

				returnData.push({
					json: unwrapResponse(response),
					pairedItem: { item: i },
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
