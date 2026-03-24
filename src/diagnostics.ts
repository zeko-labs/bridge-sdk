import { type Field, PublicKey, UInt32, UInt64 } from "o1js"
import { Bridge } from "./index"
import type { Config } from "./types"
import { createGraphqlClient } from "./graphql"
import type { Action, Deposit, OuterWitness, Withdrawal, InnerWitness } from "./types"
import {
	BRIDGE_DEPLOY_BLOCK,
	depositAux,
	fetchActions,
	fetchInnerWitnessesFromAuxes,
	fetchOuterWitnessesFromAuxes,
	withdrawalAux
} from "./utils"

export type DepositDiagnosticReason =
	| "invalid-action-shape"
	| "outer-pk-mismatch"
	| "holder-account-mismatch"
	| "missing-witness"

export type WithdrawalDiagnosticReason = "invalid-action-shape" | "missing-witness"

type WitnessSummary = {
	index: number
	afterState: string
	beforeState: string
	hash: string
}

export type DepositDiagnosticEntry = {
	hash: string
	timestamp: string
	recipient: string | null
	amount: string | null
	timeout: string | null
	holderAccountL1: string | null
	aux: string | null
	status: "matched" | "unmatched" | "filtered"
	reason: DepositDiagnosticReason | null
	witness: WitnessSummary | null
}

export type WithdrawalDiagnosticEntry = {
	hash: string
	timestamp: string
	recipient: string | null
	amount: string | null
	aux: string | null
	status: "matched" | "unmatched" | "filtered"
	reason: WithdrawalDiagnosticReason | null
	witness: WitnessSummary | null
}

export type BridgeHistoryDiagnostics = {
	walletAddress: string
	deposits: {
		entries: DepositDiagnosticEntry[]
		witnessCount: number
	}
	withdrawals: {
		entries: WithdrawalDiagnosticEntry[]
		witnessCount: number
	}
}

type RawDepositCandidate = {
	hash: string
	timestamp: string
	recipient: PublicKey
	amount: UInt64
	timeout: UInt32
	holderAccountL1: PublicKey
	aux: Field
}

type RawWithdrawalCandidate = {
	hash: string
	timestamp: string
	recipient: PublicKey
	amount: UInt64
	aux: Field
}

const witnessSummary = (witness: OuterWitness | InnerWitness): WitnessSummary => ({
	index: witness.index,
	afterState: witness.afterActionState.toString(),
	beforeState: witness.beforeActionState.toString(),
	hash: witness.hash
})

export function buildDepositDiagnostics({
	actions,
	outerPk,
	outerHolders,
	witnesses
}: {
	actions: Action[]
	outerPk: PublicKey
	outerHolders: PublicKey[]
	witnesses: OuterWitness[]
}): DepositDiagnosticEntry[] {
	const witnessesByAux = new Map(witnesses.map((witness) => [witness.aux.toString(), witness]))

	return actions.map((entry) => {
		const [
			recipient1,
			recipient2,
			amount1,
			timeout1,
			holderAccount1,
			holderAccount2,
			outer1,
			outer2
		] = entry.action

		if (
			!recipient1 ||
			!recipient2 ||
			!amount1 ||
			!timeout1 ||
			!holderAccount1 ||
			!holderAccount2 ||
			!outer1 ||
			!outer2
		) {
			return {
				hash: entry.hash,
				timestamp: entry.timestamp,
				recipient: null,
				amount: null,
				timeout: null,
				holderAccountL1: null,
				aux: null,
				status: "filtered",
				reason: "invalid-action-shape",
				witness: null
			}
		}

		const recipient = PublicKey.fromFields([recipient1, recipient2])
		const amount = UInt64.fromFields([amount1])
		const timeout = UInt32.fromFields([timeout1])
		const holderAccountL1 = PublicKey.fromFields([holderAccount1, holderAccount2])
		const actionOuterPk = PublicKey.fromFields([outer1, outer2])

		if (!actionOuterPk.equals(outerPk).toBoolean()) {
			return {
				hash: entry.hash,
				timestamp: entry.timestamp,
				recipient: recipient.toBase58(),
				amount: amount.toString(),
				timeout: timeout.toString(),
				holderAccountL1: holderAccountL1.toBase58(),
				aux: null,
				status: "filtered",
				reason: "outer-pk-mismatch",
				witness: null
			}
		}

		if (!outerHolders.some((holder) => holder.equals(holderAccountL1).toBoolean())) {
			return {
				hash: entry.hash,
				timestamp: entry.timestamp,
				recipient: recipient.toBase58(),
				amount: amount.toString(),
				timeout: timeout.toString(),
				holderAccountL1: holderAccountL1.toBase58(),
				aux: null,
				status: "filtered",
				reason: "holder-account-mismatch",
				witness: null
			}
		}

		const deposit: Deposit = { recipient, amount, timeout, holderAccountL1 }
		const aux = depositAux(deposit).toString()
		const witness = witnessesByAux.get(aux) ?? null

		return {
			hash: entry.hash,
			timestamp: entry.timestamp,
			recipient: recipient.toBase58(),
			amount: amount.toString(),
			timeout: timeout.toString(),
			holderAccountL1: holderAccountL1.toBase58(),
			aux,
			status: witness ? "matched" : "unmatched",
			reason: witness ? null : "missing-witness",
			witness: witness ? witnessSummary(witness) : null
		}
	})
}

export function buildWithdrawalDiagnostics({
	actions,
	witnesses
}: {
	actions: Action[]
	witnesses: InnerWitness[]
}): WithdrawalDiagnosticEntry[] {
	const witnessesByAux = new Map(witnesses.map((witness) => [witness.aux.toString(), witness]))

	return actions.map((entry) => {
		const [recipient1, recipient2, amount1] = entry.action

		if (!recipient1 || !recipient2 || !amount1) {
			return {
				hash: entry.hash,
				timestamp: entry.timestamp,
				recipient: null,
				amount: null,
				aux: null,
				status: "filtered",
				reason: "invalid-action-shape",
				witness: null
			}
		}

		const recipient = PublicKey.fromFields([recipient1, recipient2])
		const amount = UInt64.fromFields([amount1])
		const withdrawal: Withdrawal = { recipient, amount }
		const aux = withdrawalAux(withdrawal).toString()
		const witness = witnessesByAux.get(aux) ?? null

		return {
			hash: entry.hash,
			timestamp: entry.timestamp,
			recipient: recipient.toBase58(),
			amount: amount.toString(),
			aux,
			status: witness ? "matched" : "unmatched",
			reason: witness ? null : "missing-witness",
			witness: witness ? witnessSummary(witness) : null
		}
	})
}

const collectDepositCandidates = ({
	actions,
	outerPk,
	outerHolders
}: {
	actions: Action[]
	outerPk: PublicKey
	outerHolders: PublicKey[]
}): RawDepositCandidate[] =>
	actions.flatMap((entry) => {
		const [
			recipient1,
			recipient2,
			amount1,
			timeout1,
			holderAccount1,
			holderAccount2,
			outer1,
			outer2
		] = entry.action

		if (
			!recipient1 ||
			!recipient2 ||
			!amount1 ||
			!timeout1 ||
			!holderAccount1 ||
			!holderAccount2 ||
			!outer1 ||
			!outer2
		) {
			return []
		}

		const recipient = PublicKey.fromFields([recipient1, recipient2])
		const amount = UInt64.fromFields([amount1])
		const timeout = UInt32.fromFields([timeout1])
		const holderAccountL1 = PublicKey.fromFields([holderAccount1, holderAccount2])
		const actionOuterPk = PublicKey.fromFields([outer1, outer2])

		if (!actionOuterPk.equals(outerPk).toBoolean()) return []
		if (!outerHolders.some((holder) => holder.equals(holderAccountL1).toBoolean())) return []

		return [
			{
				hash: entry.hash,
				timestamp: entry.timestamp,
				recipient,
				amount,
				timeout,
				holderAccountL1,
				aux: depositAux({ recipient, amount, timeout, holderAccountL1 })
			}
		]
	})

const collectWithdrawalCandidates = ({
	actions
}: {
	actions: Action[]
}): RawWithdrawalCandidate[] =>
	actions.flatMap((entry) => {
		const [recipient1, recipient2, amount1] = entry.action

		if (!recipient1 || !recipient2 || !amount1) return []

		const recipient = PublicKey.fromFields([recipient1, recipient2])
		const amount = UInt64.fromFields([amount1])
		return [
			{
				hash: entry.hash,
				timestamp: entry.timestamp,
				recipient,
				amount,
				aux: withdrawalAux({ recipient, amount })
			}
		]
	})

export async function diagnoseBridgeHistory({
	config,
	walletAddress
}: {
	config: Config
	walletAddress: string
}): Promise<BridgeHistoryDiagnostics> {
	const walletPk = PublicKey.fromBase58(walletAddress)
	const [bridge, depositActions, withdrawalActions] = await Promise.all([
		Bridge.init(config),
		fetchActions(
			createGraphqlClient(config.l1ArchiveUrl, "l1-archive"),
			walletPk,
			BRIDGE_DEPLOY_BLOCK
		),
		fetchActions(createGraphqlClient(config.zekoArchiveUrl, "l2-archive"), walletPk)
	])
	const actionsApiClient = createGraphqlClient(config.actionsApi, "actions-api")

	const depositCandidates = collectDepositCandidates({
		actions: depositActions,
		outerPk: bridge.outerPk,
		outerHolders: bridge.outerHolders
	})
	const withdrawalCandidates = collectWithdrawalCandidates({ actions: withdrawalActions })

	const [depositWitnesses, withdrawalWitnesses] = await Promise.all([
		depositCandidates.length === 0
			? Promise.resolve([])
			: fetchOuterWitnessesFromAuxes(
					actionsApiClient,
					depositCandidates.map((entry) => entry.aux.toString())
				),
		withdrawalCandidates.length === 0
			? Promise.resolve([])
			: fetchInnerWitnessesFromAuxes(
					actionsApiClient,
					withdrawalCandidates.map((entry) => entry.aux.toString())
				)
	])

	return {
		walletAddress,
		deposits: {
			entries: buildDepositDiagnostics({
				actions: depositActions,
				outerPk: bridge.outerPk,
				outerHolders: bridge.outerHolders,
				witnesses: depositWitnesses
			}),
			witnessCount: depositWitnesses.length
		},
		withdrawals: {
			entries: buildWithdrawalDiagnostics({
				actions: withdrawalActions,
				witnesses: withdrawalWitnesses
			}),
			witnessCount: withdrawalWitnesses.length
		}
	}
}
