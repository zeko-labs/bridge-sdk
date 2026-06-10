import { UInt32, type Field, type Mina, type PublicKey, type UInt64 } from "o1js"
import { cancelDeposit, canCancelDeposit } from "./cancellations"
import {
	canFinalizeDeposit,
	fetchDepositFinalizationWitnesses,
	fetchDepositsWithStates,
	fetchSyncedOuterActionState,
	fetchUserDeposits,
	finalizeDeposit,
	submitDeposit
} from "./deposits"
import type { GqlClient } from "./graphql"
import { fetchAccount, fetchCurrentSlot, setL1, setL2 } from "./network"
import { createBridgeRuntime, type BridgeRuntime } from "./runtime"
import type { RetryableTransactionOptions, SignTransaction } from "./transactions"
import type {
	Account,
	Action,
	Config,
	Deposit,
	DepositWithState,
	Withdrawal,
	WithdrawalFinalizationResult,
	WithdrawalWithState
} from "./types"
import {
	canFinalizeWithdrawal,
	fetchUserWithdrawalActions,
	fetchUserWithdrawals,
	fetchWithdrawalsWithStates,
	finalizeWithdrawal,
	submitWithdrawal
} from "./withdrawals"

export * from "./actions"
export * from "./diagnostics"
export * from "./errors"
export * from "./graphql/index"
export * from "./types"

const isBridgeRuntime = (value: unknown): value is BridgeRuntime =>
	typeof value === "object" && value !== null && "config" in value && "l1Client" in value

export class Bridge {
	private readonly runtime: BridgeRuntime

	constructor(runtime: BridgeRuntime) {
		if (!isBridgeRuntime(runtime)) {
			throw new Error("Invalid Bridge runtime")
		}

		this.runtime = this.withBridgeHooks(runtime)
	}

	private withBridgeHooks(runtime: BridgeRuntime): BridgeRuntime {
		const runtimeWithDefaults = {
			...runtime,
			V2_DEPOSITS_START_INDEX: runtime.V2_DEPOSITS_START_INDEX ?? UInt32.zero,
			V2_WITHDRAWALS_START_INDEX: runtime.V2_WITHDRAWALS_START_INDEX ?? UInt32.zero
		}

		return {
			...runtimeWithDefaults,
			bridge: {
				fetchAccount: (...args) => this.fetchAccount(...args),
				fetchCurrentSlot: () => this.fetchCurrentSlot(),
				fetchDepositFinalizationWitnesses: (_runtime, pk) =>
					this.fetchDepositFinalizationWitnesses(pk),
				fetchSyncedOuterActionState: () => this.fetchSyncedOuterActionState(),
				fetchUserDeposits: (pk) => this.fetchUserDeposits(pk),
				fetchUserWithdrawals: (pk) => this.fetchUserWithdrawals(pk),
				fetchUserWithdrawalActions: (pk) => this.fetchUserWithdrawalActions(pk)
			}
		}
	}

	static async init(config: Config): Promise<Bridge> {
		return new Bridge(await createBridgeRuntime(config))
	}

	public get l1AccountCreationFee(): UInt64 {
		return this.runtime.l1AccountCreationFee
	}

	public get l2AccountCreationFee(): UInt64 {
		return this.runtime.l2AccountCreationFee
	}

	public get outerPk(): PublicKey {
		return this.runtime.outerPk
	}

	public get innerPk(): PublicKey {
		return this.runtime.innerPk
	}

	public get outerHolders(): PublicKey[] {
		return this.runtime.outerHolders
	}

	public get innerHolder(): PublicKey {
		return this.runtime.innerHolder
	}

	public get outerTokenOwner(): PublicKey {
		return this.runtime.outerTokenOwner
	}

	public get sequencerPk(): PublicKey {
		return this.runtime.sequencerPk
	}

	public get withdrawalDelay(): UInt32 {
		return this.runtime.withdrawalDelay
	}

	public get bridgeFeeRecipientL1(): PublicKey {
		return this.runtime.bridgeFeeRecipientL1
	}

	public get bridgeFeeRecipientL2(): PublicKey {
		return this.runtime.bridgeFeeRecipientL2
	}

	public get bridgeProofFee(): UInt64 {
		return this.runtime.bridgeProofFee
	}

	public setL1(): void {
		setL1(this.runtime)
	}

	public setL2(): void {
		setL2(this.runtime)
	}

	public fetchCurrentSlot(): Promise<UInt32> {
		return fetchCurrentSlot(this.runtime)
	}

	public fetchSyncedOuterActionState(): Promise<{ state: Field; length: UInt32 }> {
		return fetchSyncedOuterActionState(this.runtime)
	}

	private fetchAccount(client: GqlClient, pk: PublicKey, tokenId?: Field): Promise<Account | null> {
		return fetchAccount(client, pk, tokenId)
	}

	private fetchUserDeposits(pk: PublicKey): Promise<Deposit[]> {
		return fetchUserDeposits(this.runtime, pk)
	}

	private fetchDepositFinalizationWitnesses(pk: PublicKey) {
		return fetchDepositFinalizationWitnesses(this.runtime, pk)
	}

	private fetchUserWithdrawals(pk: PublicKey): Promise<Withdrawal[]> {
		return fetchUserWithdrawals(this.runtime, pk)
	}

	private fetchUserWithdrawalActions(pk: PublicKey): Promise<Array<Action & Withdrawal>> {
		return fetchUserWithdrawalActions(this.runtime, pk)
	}

	public submitDeposit(
		feePayer: Mina.FeePayerSpec,
		params: {
			recipient: PublicKey
			amount: UInt64
			timeout: UInt32
			holderAccountL1?: PublicKey
		},
		signTxn: SignTransaction
	): Promise<string> {
		return submitDeposit(this.runtime, feePayer, params, signTxn)
	}

	public finalizeDeposit(
		pk: PublicKey,
		signTxn: SignTransaction,
		options?: number | RetryableTransactionOptions
	): Promise<string> {
		return finalizeDeposit(this.runtime, pk, signTxn, options)
	}

	public canFinalizeDeposit(
		pk: PublicKey
	): Promise<{ available: boolean; reason: string | null; index?: number }> {
		return canFinalizeDeposit(this.runtime, pk)
	}

	public cancelDeposit(
		pk: PublicKey,
		signTxn: SignTransaction,
		outerHolder?: PublicKey,
		options?: RetryableTransactionOptions
	): Promise<string> {
		return cancelDeposit(this.runtime, pk, signTxn, outerHolder, options)
	}

	public canCancelDeposit(pk: PublicKey): Promise<{ available: boolean; reason: string | null }> {
		return canCancelDeposit(this.runtime, pk)
	}

	public submitWithdrawal(
		feePayer: Mina.FeePayerSpec,
		params: {
			recipient: PublicKey
			amount: UInt64
		},
		signTxn: SignTransaction
	): Promise<string> {
		return submitWithdrawal(this.runtime, feePayer, params, signTxn)
	}

	public finalizeWithdrawal(
		pk: PublicKey,
		signTxn: SignTransaction,
		outerHolder?: PublicKey,
		options?: RetryableTransactionOptions
	): Promise<string> {
		return finalizeWithdrawal(this.runtime, pk, signTxn, outerHolder, options)
	}

	public canFinalizeWithdrawal(pk: PublicKey): Promise<WithdrawalFinalizationResult> {
		return canFinalizeWithdrawal(this.runtime, pk)
	}

	public fetchDepositsWithStates(pk: PublicKey): Promise<{
		deposits: DepositWithState[]
		syncedIndex: number
		acceptedIndex: number
		confirmedIndex: number
		finalisedIndex: number
		cancelledIndex: number
	}> {
		return fetchDepositsWithStates(this.runtime, pk)
	}

	public fetchWithdrawalsWithStates(pk: PublicKey): Promise<{
		withdrawals: WithdrawalWithState[]
		committedIndex: number
		finalisedIndex: number
	}> {
		return fetchWithdrawalsWithStates(this.runtime, pk)
	}
}
