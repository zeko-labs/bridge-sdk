import {
	fetchConfigQuery,
	genesisConstantsQueryL1,
	genesisConstantsQueryL2,
	sequencerPkQuery
} from "@zeko-labs/graphql"
import { PublicKey, UInt32, UInt64 } from "o1js"
import { createGraphqlClient, type GqlClient } from "./graphql"
import type { Action, Account, Config, Deposit, Withdrawal } from "./types"
import type { fetchDepositFinalizationWitnesses } from "./deposits"

type RuntimeQueryError = {
	readonly message?: string
	readonly graphQLErrors?: readonly unknown[]
	readonly networkError?: unknown
}

type RuntimeQueryResult<T> = {
	readonly data?: T
	readonly error?: RuntimeQueryError
}

const formatUnknownError = (error: unknown): string => {
	if (error instanceof Error) return error.message
	if (typeof error === "string") return error

	return JSON.stringify(error) ?? String(error)
}

const formatQueryError = (error: RuntimeQueryError): string => {
	const parts = [
		error.message,
		error.networkError ? `networkError=${formatUnknownError(error.networkError)}` : undefined,
		error.graphQLErrors?.length
			? `graphQLErrors=${error.graphQLErrors.map(formatUnknownError).join("; ")}`
			: undefined
	].filter((part): part is string => Boolean(part))

	return parts.join("; ") || "unknown GraphQL error"
}

const assertQuerySucceeded = ({
	endpoint,
	queryName,
	result
}: {
	endpoint: string
	queryName: string
	result: RuntimeQueryResult<unknown>
}): void => {
	if (!result.error) return

	throw new Error(
		`GraphQL query ${queryName} failed at ${endpoint}: ${formatQueryError(result.error)}`
	)
}

const requireQueryValue = <T>({
	endpoint,
	field,
	queryName,
	value
}: {
	endpoint: string
	field: string
	queryName: string
	value: T | null | undefined
}): T => {
	if (value !== null && value !== undefined) return value

	throw new Error(`GraphQL query ${queryName} at ${endpoint} did not return ${field}`)
}

export type BridgeRuntime = {
	readonly config: Config
	readonly l1Client: GqlClient
	readonly l1ArchiveClient: GqlClient
	readonly l2Client: GqlClient
	readonly l2ArchiveClient: GqlClient
	readonly actionsApiClient: GqlClient
	readonly l1AccountCreationFee: UInt64
	readonly l2AccountCreationFee: UInt64
	readonly outerPk: PublicKey
	readonly innerPk: PublicKey
	readonly outerHolders: PublicKey[]
	readonly innerHolder: PublicKey
	readonly outerTokenOwner: PublicKey
	readonly sequencerPk: PublicKey
	readonly withdrawalDelay: UInt32
	readonly bridgeFeeRecipientL1: PublicKey
	readonly bridgeFeeRecipientL2: PublicKey
	readonly bridgeProofFee: UInt64
	readonly V2_DEPOSITS_START_INDEX: UInt32
	readonly V2_WITHDRAWALS_START_INDEX: UInt32
	readonly bridge?: {
		fetchAccount: (
			client: GqlClient,
			pk: PublicKey,
			tokenId?: import("o1js").Field
		) => Promise<Account | null>
		fetchCurrentSlot: () => Promise<UInt32>
		fetchDepositFinalizationWitnesses: typeof fetchDepositFinalizationWitnesses
		fetchSyncedOuterActionState: () => Promise<{ state: import("o1js").Field; length: UInt32 }>
		fetchUserDeposits: (pk: PublicKey) => Promise<Deposit[]>
		fetchUserWithdrawals: (pk: PublicKey) => Promise<Withdrawal[]>
		fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
	}
}

export const debug = (runtime: BridgeRuntime, message: string, details?: unknown): void => {
	if (!runtime.config.verbose) return

	if (details === undefined) {
		console.debug(message)
		return
	}

	console.debug(message, details)
}

export const createBridgeRuntime = async (config: Config): Promise<BridgeRuntime> => {
	const l1Client = createGraphqlClient(config.l1Url, "l1")
	const l1ArchiveClient = createGraphqlClient(config.l1ArchiveUrl, "l1-archive")
	const actionsApiClient = createGraphqlClient(config.actionsApi, "actions-api")
	const l2Client = createGraphqlClient(config.zekoUrl, "l2")
	const l2ArchiveClient = createGraphqlClient(config.zekoArchiveUrl, "l2-archive")

	const [fetchConfigResult, genesisConstantL2Result, genesisConstantL1Result, sequencerPkResult] =
		await Promise.all([
			l2Client().query(fetchConfigQuery, {}),
			l2Client().query(genesisConstantsQueryL2, {}),
			l1Client().query(genesisConstantsQueryL1, {}),
			l2Client().query(sequencerPkQuery, {})
		])

	assertQuerySucceeded({
		endpoint: config.zekoUrl,
		queryName: "FetchConfig",
		result: fetchConfigResult
	})
	assertQuerySucceeded({
		endpoint: config.zekoUrl,
		queryName: "GenesisConstants",
		result: genesisConstantL2Result
	})
	assertQuerySucceeded({
		endpoint: config.l1Url,
		queryName: "GenesisConstants",
		result: genesisConstantL1Result
	})
	assertQuerySucceeded({
		endpoint: config.zekoUrl,
		queryName: "SequencerPK",
		result: sequencerPkResult
	})

	const circuitsConfig = requireQueryValue({
		endpoint: config.zekoUrl,
		queryName: "FetchConfig",
		field: "circuitsConfig",
		value: fetchConfigResult.data?.circuitsConfig
	})

	const l1AccountCreationFee = requireQueryValue({
		endpoint: config.l1Url,
		queryName: "GenesisConstants",
		field: "genesisConstants.accountCreationFee",
		value: genesisConstantL1Result.data?.genesisConstants?.accountCreationFee
	})

	const l2AccountCreationFee = requireQueryValue({
		endpoint: config.zekoUrl,
		queryName: "GenesisConstants",
		field: "genesisConstants.accountCreationFee",
		value: genesisConstantL2Result.data?.genesisConstants?.accountCreationFee
	})

	const sequencerPk = requireQueryValue({
		endpoint: config.zekoUrl,
		queryName: "SequencerPK",
		field: "sequencerPk",
		value: sequencerPkResult.data?.sequencerPk
	})

	const V2_DEPOSITS_START_INDEX =
		config.l2Network === "testnet" ? UInt32.from(68520) : UInt32.from(0)
	const V2_WITHDRAWALS_START_INDEX =
		config.l2Network === "testnet" ? UInt32.from(10529) : UInt32.from(0)

	return {
		config,
		l1Client,
		l1ArchiveClient,
		l2Client,
		l2ArchiveClient,
		actionsApiClient,
		l1AccountCreationFee: UInt64.from(l1AccountCreationFee),
		l2AccountCreationFee: UInt64.from(l2AccountCreationFee),
		outerPk: PublicKey.fromBase58(circuitsConfig.zekoL1),
		innerPk: PublicKey.fromBase58(circuitsConfig.zekoL2),
		outerHolders: circuitsConfig.holderAccountsL1.map((holder) => PublicKey.fromBase58(holder)),
		innerHolder: PublicKey.fromBase58(circuitsConfig.holderAccountL2),
		outerTokenOwner: PublicKey.fromBase58(circuitsConfig.helperTokenOwnerL1),
		sequencerPk: PublicKey.fromBase58(sequencerPk),
		withdrawalDelay: UInt32.from(circuitsConfig.withdrawalDelay),
		bridgeFeeRecipientL1: PublicKey.fromBase58(circuitsConfig.bridgeFeeRecipientL1),
		bridgeFeeRecipientL2: PublicKey.fromBase58(circuitsConfig.bridgeFeeRecipientL2),
		bridgeProofFee: UInt64.from(circuitsConfig.bridgeProofFee),
		V2_DEPOSITS_START_INDEX,
		V2_WITHDRAWALS_START_INDEX
	}
}
