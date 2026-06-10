import { Field, PublicKey, UInt32, UInt64 } from "o1js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GqlClient } from "../src/graphql"
import { Bridge } from "../src/index"
import type { BridgeRuntime } from "../src/runtime"
import type { Action, Config, Deposit, InnerWitness, OuterWitness, Withdrawal } from "../src/types"
import * as utils from "../src/utils"
import { depositAux, withdrawalAux } from "../src/utils"

const recipient = PublicKey.fromBase58("B62qpuhMDp748xtE77iBXRRaipJYgs6yumAeTzaM7zS9dn8avLPaeFF")
const holder = PublicKey.fromBase58("B62qmqHbTA6X54y5M2nSxpuPae5EUE2TBQXacAEqqgn667NRVFKDSeA")
const outerPk = PublicKey.fromBase58("B62qkekmS9273D1EsFfMSJMMDAmgvh1WyoYE2vs1r7k4GtGBqVYABn2")
const innerPk = PublicKey.fromBase58("B62qjDedeP9617oTUeN8JGhdiqWg4t64NtQkHaoZB9wyvgSjAyupPU1")

const bridgeConfig: Config = {
	l1Url: "http://l1.test",
	l1ArchiveUrl: "http://l1-archive.test",
	zekoUrl: "http://l2.test",
	zekoArchiveUrl: "http://l2-archive.test",
	l1Network: "testnet",
	l2Network: "testnet",
	actionsApi: "http://actions.test"
}

const buildGraphqlClient = (payload: { data?: unknown; error?: unknown }): GqlClient =>
	Object.assign(
		() =>
			({
				query: async () => payload
			}) as unknown as ReturnType<GqlClient>,
		{ label: "test-client" }
	)

const buildBridge = () =>
	new Bridge({
		config: bridgeConfig,
		l1Client: buildGraphqlClient({}),
		l1ArchiveClient: buildGraphqlClient({}),
		l2Client: buildGraphqlClient({}),
		l2ArchiveClient: buildGraphqlClient({}),
		actionsApiClient: buildGraphqlClient({}),
		l1AccountCreationFee: UInt64.from(1),
		l2AccountCreationFee: UInt64.from(1),
		outerPk,
		innerPk,
		outerHolders: [holder],
		innerHolder: holder,
		outerTokenOwner: outerPk,
		sequencerPk: innerPk,
		withdrawalDelay: UInt32.from(10),
		bridgeFeeRecipientL1: outerPk,
		bridgeFeeRecipientL2: innerPk,
		bridgeProofFee: UInt64.from(1),
		V2_DEPOSITS_START_INDEX: UInt32.zero,
		V2_WITHDRAWALS_START_INDEX: UInt32.zero
	} satisfies BridgeRuntime)

const buildDeposit = (): Deposit => ({
	recipient,
	amount: UInt64.from(3_000_000_000),
	timeout: UInt32.from(100),
	holderAccountL1: holder
})

const buildDepositWitness = (deposit: Deposit): OuterWitness => ({
	action: [Field(1), Field(2)],
	afterActionState: Field(3),
	beforeActionState: Field(4),
	hash: "deposit-witness",
	index: 0,
	slotRange: {
		lower: UInt32.from(90),
		upper: UInt32.from(90)
	},
	timestamp: "1700000000000",
	type: "witness",
	aux: depositAux(deposit)
})

const buildWithdrawal = (): Withdrawal => ({
	recipient,
	amount: UInt64.from(3_000_000_000)
})

const buildWithdrawalAction = (withdrawal: Withdrawal): Action & Withdrawal => ({
	...withdrawal,
	action: [Field(11), Field(12)],
	afterActionState: Field(13),
	beforeActionState: Field(14),
	hash: "withdrawal-action",
	index: 0,
	timestamp: "1700000001000"
})

const buildWithdrawalWitness = (withdrawal: Withdrawal): InnerWitness => ({
	action: [Field(21), Field(22)],
	afterActionState: Field(23),
	beforeActionState: Field(24),
	hash: "withdrawal-witness",
	index: 0,
	timestamp: "1700000002000",
	aux: withdrawalAux(withdrawal)
})

const mockNullCommit = () =>
	vi.spyOn(utils, "fetchCommitAsePastSlot").mockResolvedValue({
		commit: null,
		ase: []
	})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("null commit state", () => {
	it("parses nullable commit responses from the Actions API", async () => {
		await expect(
			utils.fetchCommitAsePastSlot(
				buildGraphqlClient({
					data: {
						commitAsePastSlot: {
							commit: null,
							ase: []
						}
					}
				}),
				120
			)
		).resolves.toEqual({ commit: null, ase: [] })
	})

	it("reports deposits as unaccepted and unconfirmed when no outer commit is available", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit()
		const witness = buildDepositWitness(deposit)
		const bridgeInternals = bridge as unknown as {
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
			fetchSyncedOuterActionState: () => Promise<{ state: Field; length: UInt32 }>
			fetchUserDeposits: (pk: PublicKey) => Promise<Deposit[]>
		}

		vi.spyOn(bridgeInternals, "fetchUserDeposits").mockResolvedValue([deposit])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(null)
		vi.spyOn(bridgeInternals, "fetchSyncedOuterActionState").mockResolvedValue({
			state: witness.afterActionState,
			length: UInt32.from(1)
		})
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(120))
		vi.spyOn(utils, "fetchOuterWitnessesFromAuxes").mockResolvedValue([witness])
		vi.spyOn(utils, "fetchOuterActionsFromIndexer").mockResolvedValue([witness])
		mockNullCommit()

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.acceptedIndex).toBe(-1)
		expect(result.confirmedIndex).toBe(-1)
		expect(result.deposits).toHaveLength(1)
		expect(result.deposits[0]).toMatchObject({
			accepted: false,
			confirmed: false,
			finalised: false,
			cancelled: false,
			cancellable: false
		})
	})

	it("reports deposit finalization as waiting when no outer commit is available", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit()
		const witness = buildDepositWitness(deposit)
		const bridgeInternals = bridge as unknown as {
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
			fetchSyncedOuterActionState: () => Promise<{ state: Field; length: UInt32 }>
			fetchUserDeposits: (pk: PublicKey) => Promise<Deposit[]>
		}

		vi.spyOn(bridgeInternals, "fetchUserDeposits").mockResolvedValue([deposit])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(null)
		vi.spyOn(bridgeInternals, "fetchSyncedOuterActionState").mockResolvedValue({
			state: witness.afterActionState,
			length: UInt32.from(1)
		})
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(120))
		vi.spyOn(utils, "fetchOuterWitnessesFromAuxes").mockResolvedValue([witness])
		vi.spyOn(utils, "fetchOuterActionsFromIndexer").mockResolvedValue([witness])
		mockNullCommit()

		await expect(bridge.canFinalizeDeposit(recipient)).resolves.toEqual({
			available: false,
			reason: "No outer commit available yet"
		})
	})

	it("reports witnessed withdrawals as uncommitted when no outer commit is available", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const witness = buildWithdrawalWitness(withdrawal)
		const bridgeInternals = bridge as unknown as {
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
		}

		vi.spyOn(bridgeInternals, "fetchUserWithdrawalActions").mockResolvedValue([
			buildWithdrawalAction(withdrawal)
		])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(null)
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(120))
		vi.spyOn(utils, "fetchInnerWitnessesFromAuxes").mockResolvedValue([witness])
		mockNullCommit()

		const result = await bridge.fetchWithdrawalsWithStates(recipient)

		expect(result.committedIndex).toBe(-1)
		expect(result.withdrawals).toHaveLength(1)
		expect(result.withdrawals[0]).toMatchObject({
			committed: false,
			finalised: false
		})
	})

	it("reports withdrawal finalization as waiting when no outer commit is available", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const witness = buildWithdrawalWitness(withdrawal)
		const bridgeInternals = bridge as unknown as {
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
			fetchUserWithdrawals: (pk: PublicKey) => Promise<Withdrawal[]>
		}

		vi.spyOn(bridgeInternals, "fetchUserWithdrawals").mockResolvedValue([withdrawal])
		vi.spyOn(bridgeInternals, "fetchUserWithdrawalActions").mockResolvedValue([
			buildWithdrawalAction(withdrawal)
		])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue({ zkappState: ["0", "0"] })
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(120))
		vi.spyOn(utils, "fetchInnerWitnessesFromAuxes").mockResolvedValue([witness])
		mockNullCommit()

		await expect(bridge.canFinalizeWithdrawal(recipient)).resolves.toEqual({
			available: false,
			reason: "No outer commit available yet",
			status: "waiting"
		})
	})
})
