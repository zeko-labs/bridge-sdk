import type { TadaDocumentNode } from "gql.tada"
import type { Field, NetworkId, PublicKey, UInt32, UInt64 } from "o1js"

export type Config = {
	l1Url: string
	l1ArchiveUrl: string
	zekoUrl: string
	zekoArchiveUrl: string
	l1Network: NetworkId
	l2Network: NetworkId
	actionsApi: string
	pollTimeout?: number
}

export type Action = {
	action: Field[]
	beforeActionState: Field
	afterActionState: Field
	index: number
	timestamp: string
	hash: string
}

export type Deposit = {
	recipient: PublicKey
	amount: UInt64
	timeout: UInt32
	holderAccountL1: PublicKey
}

export type Withdrawal = {
	recipient: PublicKey
	amount: UInt64
}

export type OuterActionBase = Action & {
	index: number
	slotRange: {
		lower: UInt32
		upper: UInt32
	}
}

export type OuterWitness = OuterActionBase & {
	type: "witness"
	aux: Field
}

export type OuterCommit = OuterActionBase & {
	type: "commit"
	ledger: Field
	innerActionState: Field
	innerActionStateLength: UInt32
	synchronizedOuterActionState: Field
	synchronizedOuterActionStateLength: UInt32
}

export type InnerWitness = Action & {
	index: number
	aux: Field
}

export type OuterAction = OuterWitness | OuterCommit

export type DepositWithState = Action &
	Deposit & {
		cancelled: boolean
		synced: boolean
		accepted: boolean
		confirmed: boolean
		finalised: boolean
	}

export const DepositStateProgress = {
	SYNCED: 0,
	ACCEPTED: 1,
	CONFIRMED: 2,
	FINALISED: 3
} as const

export type WithdrawalWithState = Action &
	Withdrawal & {
		committed: boolean
		finalised: boolean
	}

export type InnerAction = InnerWitness

export type WithdrawalWithFinalised = Withdrawal & { finalised: boolean }

export type MaybeWithdrawal = InnerWitness & { withdrawal: WithdrawalWithFinalised | undefined }

export type InnerActionWithState = MaybeWithdrawal & {
	committed: boolean
	isPastWithdrawalDelay: boolean
}

export type Account = {
	zkappState?: string[] | null
}

export type WitnessFetchResult<T> = { ok: true; value: T } | { ok: false; msg: string }

export type ExtractInput<T> = T extends TadaDocumentNode<any, { input: infer I }, any> ? I : never
