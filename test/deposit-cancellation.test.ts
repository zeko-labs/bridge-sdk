import { Field, PublicKey, UInt32, UInt64 } from "o1js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GqlClient } from "../src/graphql"
import { Bridge } from "../src/index"
import type { BridgeRuntime } from "../src/runtime"
import type {
	Config,
	Deposit,
	OuterAction,
	OuterCommit,
	OuterWitness,
	WitnessFetchResult
} from "../src/types"
import * as utils from "../src/utils"
import { depositAux } from "../src/utils"

const recipient = PublicKey.fromBase58("B62qpuhMDp748xtE77iBXRRaipJYgs6yumAeTzaM7zS9dn8avLPaeFF")
const holder = PublicKey.fromBase58("B62qmqHbTA6X54y5M2nSxpuPae5EUE2TBQXacAEqqgn667NRVFKDSeA")
const outerPk = PublicKey.fromBase58("B62qkekmS9273D1EsFfMSJMMDAmgvh1WyoYE2vs1r7k4GtGBqVYABn2")
const otherOuterPk = PublicKey.fromBase58("B62qjDedeP9617oTUeN8JGhdiqWg4t64NtQkHaoZB9wyvgSjAyupPU1")

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
		innerPk: otherOuterPk,
		outerHolders: [holder],
		innerHolder: holder,
		outerTokenOwner: outerPk,
		sequencerPk: otherOuterPk,
		withdrawalDelay: UInt32.from(10),
		bridgeFeeRecipientL1: outerPk,
		bridgeFeeRecipientL2: otherOuterPk,
		bridgeProofFee: UInt64.from(1),
		V2_DEPOSITS_START_INDEX: UInt32.zero,
		V2_WITHDRAWALS_START_INDEX: UInt32.zero
	} satisfies BridgeRuntime)

const buildDeposit = ({ amount, timeout }: { amount: number; timeout: number }): Deposit => ({
	recipient,
	amount: UInt64.from(amount),
	timeout: UInt32.from(timeout),
	holderAccountL1: holder
})

const buildDepositWitness = (
	deposit: Deposit,
	index: number,
	slotRange: { lower: number; upper: number }
): OuterWitness => ({
	action: [Field(index + 1), Field(index + 101)],
	afterActionState: Field(index + 201),
	beforeActionState: Field(index + 200),
	hash: `deposit-witness-${index}`,
	index,
	slotRange: {
		lower: UInt32.from(slotRange.lower),
		upper: UInt32.from(slotRange.upper)
	},
	timestamp: `${1700000000000 + index}`,
	type: "witness",
	aux: depositAux(deposit)
})

const buildOuterWitness = ({
	index,
	lower,
	upper,
	aux = Field(index + 500)
}: {
	index: number
	lower: number
	upper: number
	aux?: Field
}): OuterWitness => ({
	action: [Field(index + 301), Field(index + 401)],
	afterActionState: Field(index + 601),
	beforeActionState: Field(index + 600),
	hash: `outer-witness-${index}`,
	index,
	slotRange: {
		lower: UInt32.from(lower),
		upper: UInt32.from(upper)
	},
	timestamp: `${1700000001000 + index}`,
	type: "witness",
	aux
})

const buildCommit = ({
	index,
	lower,
	upper,
	synchronizedLength
}: {
	index: number
	lower: number
	upper: number
	synchronizedLength: number
}): OuterCommit => ({
	action: [Field(index + 701), Field(index + 801)],
	afterActionState: Field(index + 901),
	beforeActionState: Field(index + 900),
	hash: `commit-${index}`,
	index,
	slotRange: {
		lower: UInt32.from(lower),
		upper: UInt32.from(upper)
	},
	timestamp: `${1700000002000 + index}`,
	type: "commit",
	ledger: Field(index + 1001),
	innerActionState: Field(index + 1101),
	innerActionStateLength: UInt32.zero,
	synchronizedOuterActionState: Field(index + 1201),
	synchronizedOuterActionStateLength: UInt32.from(synchronizedLength)
})

const mockDepositState = ({
	bridge,
	deposits,
	depositWitnesses,
	outerActions,
	lastCommit,
	nextCancelledDeposit = 0,
	nextDeposit = 0,
	syncedLength = 0,
	syncedState = Field(9_999)
}: {
	bridge: Bridge
	deposits: Deposit[]
	depositWitnesses: OuterWitness[]
	outerActions: OuterAction[]
	lastCommit: OuterCommit
	nextCancelledDeposit?: number
	nextDeposit?: number
	syncedLength?: number
	syncedState?: Field
}) => {
	const bridgeInternals = bridge as unknown as {
		fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
		fetchCurrentSlot: () => Promise<UInt32>
		fetchSyncedOuterActionState: () => Promise<{ state: Field; length: UInt32 }>
		fetchUserDeposits: (pk: PublicKey) => Promise<Deposit[]>
	}

	vi.spyOn(bridgeInternals, "fetchUserDeposits").mockResolvedValue(deposits)
	const fetchAccountSpy = vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(null)
	fetchAccountSpy
		.mockResolvedValueOnce({ zkappState: [String(nextCancelledDeposit)] })
		.mockResolvedValueOnce({ zkappState: [String(nextDeposit)] })
	vi.spyOn(bridgeInternals, "fetchSyncedOuterActionState").mockResolvedValue({
		state: syncedState,
		length: UInt32.from(syncedLength)
	})
	vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(100))

	vi.spyOn(utils, "fetchOuterWitnessesFromAuxes").mockResolvedValue(depositWitnesses)
	vi.spyOn(utils, "fetchOuterActionsFromIndexer").mockResolvedValue(outerActions)
	vi.spyOn(utils, "fetchCommitAsePastSlot").mockResolvedValue({
		commit: lastCommit,
		ase: []
	})
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("deposit cancellation state", () => {
	it("marks a rejected deposit as cancellable and keeps canCancelDeposit aligned", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit({ amount: 10, timeout: 5 })
		const depositWitness = buildDepositWitness(deposit, 0, { lower: 0, upper: 1 })
		const timeoutWitness = buildOuterWitness({ index: 1, lower: 6, upper: 6 })
		const lastCommit = buildCommit({ index: 2, lower: 7, upper: 7, synchronizedLength: 1 })

		mockDepositState({
			bridge,
			deposits: [deposit],
			depositWitnesses: [depositWitness],
			outerActions: [depositWitness, timeoutWitness, lastCommit],
			lastCommit,
			syncedLength: 1
		})

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.deposits).toHaveLength(1)
		expect(result.deposits[0]?.cancellable).toBe(true)
		expect(result.deposits[0]?.cancelled).toBe(false)
		expect(result.deposits[0]?.finalised).toBe(false)
		await expect(bridge.canCancelDeposit(recipient)).resolves.toEqual({
			available: true,
			reason: null
		})
	})

	it("marks multiple rejected deposits as cancellable", async () => {
		const bridge = buildBridge()
		const firstDeposit = buildDeposit({ amount: 10, timeout: 3 })
		const secondDeposit = buildDeposit({ amount: 12, timeout: 8 })
		const firstWitness = buildDepositWitness(firstDeposit, 0, { lower: 0, upper: 1 })
		const secondWitness = buildDepositWitness(secondDeposit, 1, { lower: 2, upper: 3 })
		const timeoutWitness = buildOuterWitness({ index: 2, lower: 10, upper: 10 })
		const lastCommit = buildCommit({ index: 3, lower: 12, upper: 12, synchronizedLength: 1 })

		mockDepositState({
			bridge,
			deposits: [firstDeposit, secondDeposit],
			depositWitnesses: [firstWitness, secondWitness],
			outerActions: [firstWitness, secondWitness, timeoutWitness, lastCommit],
			lastCommit,
			syncedLength: 1
		})

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.deposits.map((deposit) => deposit.cancellable)).toEqual([true, true])
		await expect(bridge.canCancelDeposit(recipient)).resolves.toEqual({
			available: true,
			reason: null
		})
	})

	it("keeps pending deposits non-cancellable", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit({ amount: 14, timeout: 10 })
		const depositWitness = buildDepositWitness(deposit, 1, { lower: 1, upper: 2 })
		const lastCommit = buildCommit({ index: 0, lower: 0, upper: 0, synchronizedLength: 0 })

		mockDepositState({
			bridge,
			deposits: [deposit],
			depositWitnesses: [depositWitness],
			outerActions: [lastCommit, depositWitness],
			lastCommit
		})

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.deposits[0]?.cancellable).toBe(false)
		await expect(bridge.canCancelDeposit(recipient)).resolves.toEqual({
			available: false,
			reason: "No cancellable deposit found"
		})
	})

	it("does not mark accepted deposits as cancellable", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit({ amount: 16, timeout: 5 })
		const depositWitness = buildDepositWitness(deposit, 0, { lower: 0, upper: 1 })
		const lastCommit = buildCommit({ index: 1, lower: 4, upper: 4, synchronizedLength: 1 })

		mockDepositState({
			bridge,
			deposits: [deposit],
			depositWitnesses: [depositWitness],
			outerActions: [depositWitness, lastCommit],
			lastCommit,
			syncedLength: 1
		})

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.deposits[0]?.accepted).toBe(true)
		expect(result.deposits[0]?.cancellable).toBe(false)
	})

	it("does not mark cancelled deposits as cancellable", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit({ amount: 18, timeout: 5 })
		const depositWitness = buildDepositWitness(deposit, 0, { lower: 0, upper: 1 })
		const timeoutWitness = buildOuterWitness({ index: 1, lower: 6, upper: 6 })
		const lastCommit = buildCommit({ index: 2, lower: 7, upper: 7, synchronizedLength: 1 })

		mockDepositState({
			bridge,
			deposits: [deposit],
			depositWitnesses: [depositWitness],
			outerActions: [depositWitness, timeoutWitness, lastCommit],
			lastCommit,
			nextCancelledDeposit: 1,
			syncedLength: 1
		})

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.deposits[0]?.cancelled).toBe(true)
		expect(result.deposits[0]?.cancellable).toBe(false)
	})

	it("does not mark finalised deposits as cancellable", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit({ amount: 20, timeout: 8 })
		const depositWitness = buildDepositWitness(deposit, 0, { lower: 0, upper: 1 })
		const timeoutWitness = buildOuterWitness({ index: 1, lower: 6, upper: 6 })
		const lastCommit = buildCommit({ index: 2, lower: 7, upper: 7, synchronizedLength: 1 })

		mockDepositState({
			bridge,
			deposits: [deposit],
			depositWitnesses: [depositWitness],
			outerActions: [depositWitness, timeoutWitness, lastCommit],
			lastCommit,
			nextDeposit: 1,
			syncedLength: 1
		})

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.deposits[0]?.finalised).toBe(true)
		expect(result.deposits[0]?.cancellable).toBe(false)
	})

	it("marks finalised deposits by local action position when outer indices are absolute", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit({ amount: 20, timeout: 8 })
		const depositWitness = buildDepositWitness(deposit, 8951, { lower: 0, upper: 1 })
		const lastCommit = buildCommit({ index: 8952, lower: 7, upper: 7, synchronizedLength: 8952 })

		mockDepositState({
			bridge,
			deposits: [deposit],
			depositWitnesses: [depositWitness],
			outerActions: [depositWitness, lastCommit],
			lastCommit,
			nextDeposit: 8952,
			syncedLength: 8952
		})

		const result = await bridge.fetchDepositsWithStates(recipient)

		expect(result.deposits[0]?.finalised).toBe(true)
		expect(result.deposits[0]?.cancellable).toBe(false)
	})

	it("keeps the older required deposit as the finalization target", async () => {
		const bridge = buildBridge()
		const bridgeInternals = bridge as unknown as {
			fetchDepositFinalizationWitnesses: (
				pk: PublicKey
			) => ReturnType<Bridge["canFinalizeDeposit"]> | Promise<unknown>
		}
		const firstDeposit = buildDeposit({ amount: 10, timeout: 20 })
		const secondDeposit = buildDeposit({ amount: 12, timeout: 20 })
		const firstWitness = buildDepositWitness(firstDeposit, 0, { lower: 0, upper: 1 })
		const secondWitness = buildDepositWitness(secondDeposit, 1, { lower: 2, upper: 3 })
		const lastCommit = buildCommit({ index: 2, lower: 4, upper: 4, synchronizedLength: 2 })

		mockDepositState({
			bridge,
			deposits: [firstDeposit, secondDeposit],
			depositWitnesses: [firstWitness, secondWitness],
			outerActions: [firstWitness, secondWitness, lastCommit],
			lastCommit,
			syncedLength: 2,
			syncedState: lastCommit.afterActionState
		})

		const result = (await bridgeInternals.fetchDepositFinalizationWitnesses(
			recipient
		)) as WitnessFetchResult<{
			witness: { checkAccepted: { init: { depositIndex: string } } }
		}>

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error("Expected a finalization witness")
		expect(result.value.witness.checkAccepted.init.depositIndex).toBe("0")
		await expect(bridge.canFinalizeDeposit(recipient)).resolves.toEqual({
			index: 0,
			available: true,
			reason: null
		})
	})

	it("skips older cancellable deposits when selecting the finalization target", async () => {
		const bridge = buildBridge()
		const bridgeInternals = bridge as unknown as {
			fetchDepositFinalizationWitnesses: (
				pk: PublicKey
			) => ReturnType<Bridge["canFinalizeDeposit"]> | Promise<unknown>
		}
		const firstDeposit = buildDeposit({ amount: 10, timeout: 5 })
		const secondDeposit = buildDeposit({ amount: 12, timeout: 8 })
		const firstWitness = buildDepositWitness(firstDeposit, 0, { lower: 0, upper: 1 })
		const secondWitness = buildDepositWitness(secondDeposit, 1, { lower: 2, upper: 3 })
		const timeoutWitness = buildOuterWitness({ index: 2, lower: 6, upper: 6 })
		const lastCommit = buildCommit({ index: 3, lower: 7, upper: 7, synchronizedLength: 2 })

		mockDepositState({
			bridge,
			deposits: [firstDeposit, secondDeposit],
			depositWitnesses: [firstWitness, secondWitness],
			outerActions: [firstWitness, secondWitness, timeoutWitness, lastCommit],
			lastCommit,
			syncedLength: 2,
			syncedState: lastCommit.afterActionState
		})

		const result = (await bridgeInternals.fetchDepositFinalizationWitnesses(
			recipient
		)) as WitnessFetchResult<{
			witness: { checkAccepted: { init: { depositIndex: string } } }
		}>

		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error("Expected a finalization witness")
		expect(result.value.witness.checkAccepted.init.depositIndex).toBe("1")
		await expect(bridge.canFinalizeDeposit(recipient)).resolves.toEqual({
			index: 1,
			available: true,
			reason: null
		})
	})

	it("reports when an earlier deposit must resolve before later deposits can finalize", async () => {
		const bridge = buildBridge()
		const firstDeposit = buildDeposit({ amount: 10, timeout: 20 })
		const secondDeposit = buildDeposit({ amount: 12, timeout: 20 })
		const firstWitness = buildDepositWitness(firstDeposit, 0, { lower: 0, upper: 1 })
		const secondWitness = buildDepositWitness(secondDeposit, 1, { lower: 2, upper: 3 })
		const lastCommit = buildCommit({ index: 2, lower: 4, upper: 4, synchronizedLength: 2 })

		mockDepositState({
			bridge,
			deposits: [firstDeposit, secondDeposit],
			depositWitnesses: [firstWitness, secondWitness],
			outerActions: [firstWitness, secondWitness, lastCommit],
			lastCommit,
			syncedLength: 0
		})

		await expect(bridge.canFinalizeDeposit(recipient)).resolves.toEqual({
			available: false,
			reason: "Deposit is not finalizable yet; an earlier deposit must be resolved first"
		})
	})

	it("reports when an accepted deposit is waiting for outer commit confirmation", async () => {
		const bridge = buildBridge()
		const deposit = buildDeposit({ amount: 10, timeout: 20 })
		const depositWitness = buildDepositWitness(deposit, 1, { lower: 0, upper: 1 })
		const lastCommit = buildCommit({ index: 1, lower: 4, upper: 4, synchronizedLength: 1 })

		mockDepositState({
			bridge,
			deposits: [deposit],
			depositWitnesses: [depositWitness],
			outerActions: [depositWitness, lastCommit],
			lastCommit,
			syncedLength: 1,
			syncedState: lastCommit.afterActionState
		})

		await expect(bridge.canFinalizeDeposit(recipient)).resolves.toEqual({
			available: false,
			reason:
				"Deposit 1 is accepted but not confirmed yet; confirmedIndex 0 is behind deposit index 1"
		})
	})
})
