import { Field, PublicKey, UInt32, UInt64 } from "o1js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { GqlClient } from "../src/graphql"
import { Bridge } from "../src/index"
import type { BridgeRuntime } from "../src/runtime"
import type { Action, Config, InnerWitness, OuterCommit, Withdrawal } from "../src/types"
import * as utils from "../src/utils"
import { withdrawalAux } from "../src/utils"

const recipient = PublicKey.fromBase58("B62qpuhMDp748xtE77iBXRRaipJYgs6yumAeTzaM7zS9dn8avLPaeFF")
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

const buildBridge = ({
	l1AccountCreationFee = 1,
	l2AccountCreationFee = 1,
	bridgeProofFee = 1
}: {
	l1AccountCreationFee?: number
	l2AccountCreationFee?: number
	bridgeProofFee?: number
} = {}) =>
	new Bridge({
		config: bridgeConfig,
		l1Client: buildGraphqlClient({}),
		l1ArchiveClient: buildGraphqlClient({}),
		l2Client: buildGraphqlClient({}),
		l2ArchiveClient: buildGraphqlClient({}),
		actionsApiClient: buildGraphqlClient({}),
		l1AccountCreationFee: UInt64.from(l1AccountCreationFee),
		l2AccountCreationFee: UInt64.from(l2AccountCreationFee),
		outerPk,
		innerPk,
		outerHolders: [outerPk],
		innerHolder: outerPk,
		outerTokenOwner: outerPk,
		sequencerPk: innerPk,
		withdrawalDelay: UInt32.from(10),
		bridgeFeeRecipientL1: outerPk,
		bridgeFeeRecipientL2: innerPk,
		bridgeProofFee: UInt64.from(bridgeProofFee),
		V2_DEPOSITS_START_INDEX: UInt32.zero,
		V2_WITHDRAWALS_START_INDEX: UInt32.zero
	} satisfies BridgeRuntime)

const buildWithdrawal = ({ amount = 2_000_000_000 }: { amount?: number } = {}): Withdrawal => ({
	recipient,
	amount: UInt64.from(amount)
})

const buildInnerWitness = (withdrawal: Withdrawal, index: number): InnerWitness => ({
	action: [Field(index + 1), Field(index + 101)],
	afterActionState: Field(index + 201),
	beforeActionState: Field(index + 200),
	hash: `withdrawal-witness-${index}`,
	index,
	timestamp: `${1700000000000 + index}`,
	aux: withdrawalAux(withdrawal)
})

const buildWithdrawalAction = (withdrawal: Withdrawal, index: number): Action & Withdrawal => ({
	...withdrawal,
	action: [Field(index + 1), Field(index + 101)],
	afterActionState: Field(index + 201),
	beforeActionState: Field(index + 200),
	hash: `withdrawal-action-${index}`,
	index,
	timestamp: `${1700000000000 + index}`
})

const buildRawWithdrawalAction = (
	withdrawal: Withdrawal,
	{
		index,
		beforeState,
		afterState,
		hash
	}: { index: number; beforeState: number; afterState: number; hash: string }
): Action => ({
	action: [...withdrawal.recipient.toFields(), ...withdrawal.amount.toFields()],
	afterActionState: Field(afterState),
	beforeActionState: Field(beforeState),
	hash,
	index,
	timestamp: `${1700000000000 + index}`
})

const buildCommit = ({
	innerActionStateLength
}: { innerActionStateLength: number }): OuterCommit => ({
	action: [Field(701), Field(801)],
	afterActionState: Field(901),
	beforeActionState: Field(900),
	hash: "commit-0",
	index: 0,
	slotRange: {
		lower: UInt32.from(0),
		upper: UInt32.from(90)
	},
	timestamp: "1700000002000",
	type: "commit",
	ledger: Field(1001),
	innerActionState: Field(1101),
	innerActionStateLength: UInt32.from(innerActionStateLength),
	synchronizedOuterActionState: Field(1201),
	synchronizedOuterActionStateLength: UInt32.zero
})

const mockWithdrawalState = ({
	bridge,
	withdrawal,
	witness,
	nextWithdrawal = 0,
	innerActions = [witness],
	helperAccountExists
}: {
	bridge: Bridge
	withdrawal: Withdrawal
	witness: InnerWitness
	nextWithdrawal?: number
	innerActions?: InnerWitness[]
	helperAccountExists?: boolean
}) => {
	const bridgeInternals = bridge as unknown as {
		fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
		fetchCurrentSlot: () => Promise<UInt32>
		fetchUserWithdrawals: (pk: PublicKey) => Promise<Withdrawal[]>
		fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
	}

	vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(
		helperAccountExists === false
			? null
			: {
					zkappState: ["0", String(nextWithdrawal)]
				}
	)
	vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(100))
	vi.spyOn(bridgeInternals, "fetchUserWithdrawals").mockResolvedValue([withdrawal])
	vi.spyOn(bridgeInternals, "fetchUserWithdrawalActions").mockResolvedValue([
		buildWithdrawalAction(withdrawal, witness.index)
	])
	vi.spyOn(utils, "fetchInnerWitnessesFromAuxes").mockResolvedValue([witness])
	vi.spyOn(utils, "fetchInnerActionsFromIndexer").mockResolvedValue(innerActions)
	vi.spyOn(utils, "fetchCommitAsePastSlot").mockResolvedValue({
		commit: buildCommit({ innerActionStateLength: witness.index + 1 }),
		ase: []
	})
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("withdrawal finalization state", () => {
	it("reports the finalizable withdrawal index", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const witness = buildInnerWitness(withdrawal, 4)
		mockWithdrawalState({ bridge, withdrawal, witness })

		await expect(bridge.canFinalizeWithdrawal(recipient)).resolves.toMatchObject({
			available: true,
			status: "available",
			reason: null,
			index: 4
		})
	})

	it("falls back to cursorless live withdrawal actions when the archive cursor is not retained live", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const archivedAction = buildRawWithdrawalAction(withdrawal, {
			index: 0,
			beforeState: 200,
			afterState: 201,
			hash: "archived-withdrawal"
		})
		const liveDuplicate = buildRawWithdrawalAction(withdrawal, {
			index: 10,
			beforeState: 200,
			afterState: 201,
			hash: "live-duplicate"
		})
		const liveAction = buildRawWithdrawalAction(withdrawal, {
			index: 11,
			beforeState: 201,
			afterState: 202,
			hash: "live-withdrawal"
		})
		const bridgeInternals = bridge as unknown as {
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
		}
		const fetchRecentActions = vi
			.spyOn(utils, "fetchRecentActions")
			.mockRejectedValueOnce({
				message:
					"from 4474967054315016516812122185988395396069982311953508365013897653982583369647 not found"
			})
			.mockResolvedValueOnce([liveDuplicate, liveAction])

		vi.spyOn(utils, "fetchActions").mockResolvedValue([archivedAction])

		const actions = await bridgeInternals.fetchUserWithdrawalActions(recipient)

		expect(fetchRecentActions).toHaveBeenNthCalledWith(1, expect.any(Function), recipient, "201")
		expect(fetchRecentActions).toHaveBeenNthCalledWith(2, expect.any(Function), recipient)
		expect(actions.map((action) => action.afterActionState.toString())).toEqual(["201", "202"])
		expect(actions.map((action) => action.hash)).toEqual(["archived-withdrawal", "live-withdrawal"])
	})

	it("deduplicates incremental live withdrawal actions without assuming cursor action order", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const archivedAction = buildRawWithdrawalAction(withdrawal, {
			index: 0,
			beforeState: 200,
			afterState: 201,
			hash: "archived-withdrawal"
		})
		const liveAction = buildRawWithdrawalAction(withdrawal, {
			index: 11,
			beforeState: 201,
			afterState: 202,
			hash: "live-withdrawal"
		})
		const liveDuplicate = buildRawWithdrawalAction(withdrawal, {
			index: 10,
			beforeState: 200,
			afterState: 201,
			hash: "live-duplicate"
		})
		const bridgeInternals = bridge as unknown as {
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
		}

		vi.spyOn(utils, "fetchActions").mockResolvedValue([archivedAction])
		vi.spyOn(utils, "fetchRecentActions").mockResolvedValue([liveAction, liveDuplicate])

		const actions = await bridgeInternals.fetchUserWithdrawalActions(recipient)

		expect(actions.map((action) => action.afterActionState.toString())).toEqual(["201", "202"])
		expect(actions.map((action) => action.hash)).toEqual(["archived-withdrawal", "live-withdrawal"])
	})

	it("reports an already-finalised withdrawal when helper state has consumed its index", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const witness = buildInnerWitness(withdrawal, 0)
		mockWithdrawalState({ bridge, withdrawal, witness, nextWithdrawal: 1 })

		await expect(bridge.canFinalizeWithdrawal(recipient)).resolves.toMatchObject({
			available: false,
			status: "alreadyFinalised",
			reason: "Withdrawal already finalised",
			index: 0
		})
	})

	it("reports already-finalised from matching witnesses when the commit range no longer includes the action", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const witness = buildInnerWitness(withdrawal, 0)
		mockWithdrawalState({ bridge, withdrawal, witness, nextWithdrawal: 1, innerActions: [] })

		await expect(bridge.canFinalizeWithdrawal(recipient)).resolves.toMatchObject({
			available: false,
			status: "alreadyFinalised",
			reason: "Withdrawal already finalised",
			index: 0
		})
	})

	it("marks witnessed withdrawals finalised when helper state has consumed their index", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawal()
		const witness = buildInnerWitness(withdrawal, 0)
		mockWithdrawalState({ bridge, withdrawal, witness, nextWithdrawal: 1 })

		const result = await bridge.fetchWithdrawalsWithStates(recipient)

		expect(result.withdrawals).toHaveLength(1)
		expect(result.withdrawals[0]?.finalised).toBe(true)
		expect(result.finalisedIndex).toBe(0)
	})

	it("blocks first withdrawals below the l1 account creation plus bridge proof fee threshold", async () => {
		const bridge = buildBridge({
			l1AccountCreationFee: 1_000_000_000,
			bridgeProofFee: 500_000_000
		})
		const withdrawal = buildWithdrawal({ amount: 1_000_000_001 })
		const witness = buildInnerWitness(withdrawal, 0)
		mockWithdrawalState({ bridge, withdrawal, witness, helperAccountExists: false })

		await expect(bridge.canFinalizeWithdrawal(recipient)).resolves.toMatchObject({
			available: false,
			status: "blocked",
			reason: expect.stringContaining("at least 1.5 MINA")
		})
	})
})
