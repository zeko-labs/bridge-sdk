import { afterEach, describe, expect, it, vi } from "vitest"
import { Field, PublicKey, UInt32, UInt64 } from "o1js"
import type { GqlClient } from "../src/graphql"
import { Bridge } from "../src/index"
import type { BridgeRuntime } from "../src/runtime"
import type { Action, Config, InnerWitness, OuterCommit, Withdrawal } from "../src/types"
import * as utils from "../src/utils"

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

const buildBridge = ({ v2WithdrawalsStartIndex = UInt32.zero } = {}) =>
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
		V2_WITHDRAWALS_START_INDEX: v2WithdrawalsStartIndex
	} satisfies BridgeRuntime)

const buildWithdrawalAction = ({
	index,
	timestamp
}: {
	index: number
	timestamp: string
}): Action & Withdrawal => ({
	action: [Field(index + 1), Field(index + 101), Field(index + 201)],
	beforeActionState: Field(index + 301),
	afterActionState: Field(index + 302),
	index,
	timestamp,
	hash: `withdrawal-${index}`,
	recipient,
	amount: UInt64.from(5)
})

const lastCommit: OuterCommit = {
	action: [Field(1), Field(2)],
	afterActionState: Field(3),
	beforeActionState: Field(4),
	hash: "commit",
	index: 0,
	slotRange: { lower: UInt32.from(1), upper: UInt32.from(1) },
	timestamp: "1700000000000",
	type: "commit",
	ledger: Field(5),
	innerActionState: Field(6),
	innerActionStateLength: UInt32.zero,
	synchronizedOuterActionState: Field(7),
	synchronizedOuterActionStateLength: UInt32.zero
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("withdrawal state", () => {
	it("normalizes unresolved withdrawal timestamps when the archive does not provide one", async () => {
		const bridge = buildBridge()
		const bridgeInternals = bridge as unknown as {
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
		}

		vi.spyOn(bridgeInternals, "fetchUserWithdrawalActions").mockResolvedValue([
			buildWithdrawalAction({ index: 0, timestamp: "0" })
		])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(null)
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(100))
		vi.spyOn(utils, "fetchInnerWitnessesFromAuxes").mockResolvedValue([])
		vi.spyOn(utils, "fetchCommitAsePastSlot").mockResolvedValue({
			commit: lastCommit,
			ase: []
		})

		const result = await bridge.fetchWithdrawalsWithStates(recipient)

		expect(result.withdrawals).toHaveLength(1)
		expect(result.withdrawals[0]?.index).toBe(0)
		expect(result.withdrawals[0]?.timestamp).toBe("")
		expect(result.withdrawals[0]?.committed).toBe(false)
		expect(result.withdrawals[0]?.finalised).toBe(false)
	})

	it("normalizes witnessed withdrawal timestamps when the witness timestamp is unresolved", async () => {
		const bridge = buildBridge()
		const withdrawal = buildWithdrawalAction({ index: 0, timestamp: "1700000000000" })
		const bridgeInternals = bridge as unknown as {
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
		}
		const witness: InnerWitness = {
			action: withdrawal.action,
			beforeActionState: Field(401),
			afterActionState: Field(402),
			index: 0,
			timestamp: "0",
			hash: "withdrawal-witness",
			aux: utils.withdrawalAux(withdrawal)
		}

		vi.spyOn(bridgeInternals, "fetchUserWithdrawalActions").mockResolvedValue([withdrawal])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(null)
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(100))
		vi.spyOn(utils, "fetchInnerWitnessesFromAuxes").mockResolvedValue([witness])
		vi.spyOn(utils, "fetchCommitAsePastSlot").mockResolvedValue({
			commit: lastCommit,
			ase: []
		})

		const result = await bridge.fetchWithdrawalsWithStates(recipient)

		expect(result.withdrawals).toHaveLength(1)
		expect(result.withdrawals[0]?.timestamp).toBe("")
		expect(result.withdrawals[0]?.committed).toBe(false)
		expect(result.withdrawals[0]?.finalised).toBe(false)
	})

	it("marks unwitnessed withdrawals finalised when the helper account has advanced past them", async () => {
		const bridge = buildBridge()
		const bridgeInternals = bridge as unknown as {
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
		}

		vi.spyOn(bridgeInternals, "fetchUserWithdrawalActions").mockResolvedValue([
			buildWithdrawalAction({ index: 0, timestamp: "1700000000000" })
		])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue({
			zkappState: ["0", "1"]
		})
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(100))
		vi.spyOn(utils, "fetchInnerWitnessesFromAuxes").mockResolvedValue([])
		vi.spyOn(utils, "fetchCommitAsePastSlot").mockResolvedValue({
			commit: null,
			ase: []
		})

		const result = await bridge.fetchWithdrawalsWithStates(recipient)

		expect(result.withdrawals).toHaveLength(1)
		expect(result.withdrawals[0]?.index).toBe(0)
		expect(result.withdrawals[0]?.committed).toBe(true)
		expect(result.withdrawals[0]?.finalised).toBe(true)
		expect(result.committedIndex).toBe(-1)
		expect(result.finalisedIndex).toBe(0)
	})

	it("keeps unwitnessed withdrawal actions in queue state", async () => {
		const bridge = buildBridge({ v2WithdrawalsStartIndex: UInt32.from(1) })
		const bridgeInternals = bridge as unknown as {
			fetchUserWithdrawalActions: (pk: PublicKey) => Promise<Array<Action & Withdrawal>>
			fetchAccount: (...args: unknown[]) => Promise<{ zkappState: string[] | null } | null>
			fetchCurrentSlot: () => Promise<UInt32>
		}

		vi.spyOn(bridgeInternals, "fetchUserWithdrawalActions").mockResolvedValue([
			buildWithdrawalAction({ index: 0, timestamp: "1700000000000" }),
			buildWithdrawalAction({ index: 1, timestamp: "1700000001000" })
		])
		vi.spyOn(bridgeInternals, "fetchAccount").mockResolvedValue(null)
		vi.spyOn(bridgeInternals, "fetchCurrentSlot").mockResolvedValue(UInt32.from(100))
		vi.spyOn(utils, "fetchInnerWitnessesFromAuxes").mockResolvedValue([])
		vi.spyOn(utils, "fetchCommitAsePastSlot").mockResolvedValue({
			commit: null,
			ase: []
		})

		const result = await bridge.fetchWithdrawalsWithStates(recipient)

		expect(result.withdrawals.map((withdrawal) => withdrawal.index)).toEqual([0, 1])
		expect(result.withdrawals.map((withdrawal) => withdrawal.bridgeVersion)).toEqual([1, 2])
	})
})
