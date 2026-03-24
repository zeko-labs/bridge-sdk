import { describe, expect, it } from "vitest"
import { Field, PublicKey, UInt32, UInt64 } from "o1js"
import type { Action, InnerWitness, OuterWitness } from "../src/types"
import { buildDepositDiagnostics, buildWithdrawalDiagnostics } from "../src/diagnostics"
import {
	depositAux,
	fetchActions,
	fetchInnerWitnessesFromAuxes,
	fetchOuterWitnessesFromAuxes,
	withdrawalAux
} from "../src/utils"
import type { GqlClient } from "../src/graphql"

const recipient = PublicKey.fromBase58("B62qpuhMDp748xtE77iBXRRaipJYgs6yumAeTzaM7zS9dn8avLPaeFF")
const holder = PublicKey.fromBase58("B62qmqHbTA6X54y5M2nSxpuPae5EUE2TBQXacAEqqgn667NRVFKDSeA")
const otherHolder = PublicKey.fromBase58("B62qpXxjsnR6XfV8KUGobiiYqiSjvHq59KKhXgvSXL61pSffKc8ggcb")
const outerPk = PublicKey.fromBase58("B62qkekmS9273D1EsFfMSJMMDAmgvh1WyoYE2vs1r7k4GtGBqVYABn2")
const otherOuterPk = PublicKey.fromBase58("B62qjDedeP9617oTUeN8JGhdiqWg4t64NtQkHaoZB9wyvgSjAyupPU1")

const buildGraphqlClient = (payload: { data?: unknown; error?: unknown }): GqlClient =>
	Object.assign(
		() =>
			({
				query: async () => payload
			}) as unknown as ReturnType<GqlClient>,
		{ label: "test-client" }
	)

const depositAction = (fields: Field[]): Action => ({
	action: fields,
	beforeActionState: Field(0),
	afterActionState: Field(1),
	hash: "deposit-hash",
	index: 0,
	timestamp: "1700000000000"
})

const withdrawalAction = (fields: Field[]): Action => ({
	action: fields,
	beforeActionState: Field(0),
	afterActionState: Field(2),
	hash: "withdrawal-hash",
	index: 0,
	timestamp: "1700000001000"
})

describe("bridge diagnostics", () => {
	it("classifies deposits by filter and witness match status", () => {
		const matchedDeposit = depositAction([
			...recipient.toFields(),
			...UInt64.from(10).toFields(),
			...UInt32.from(5).toFields(),
			...holder.toFields(),
			...outerPk.toFields()
		])
		const missingWitnessDeposit = depositAction([
			...recipient.toFields(),
			...UInt64.from(11).toFields(),
			...UInt32.from(6).toFields(),
			...holder.toFields(),
			...outerPk.toFields()
		])
		const wrongOuterDeposit = depositAction([
			...recipient.toFields(),
			...UInt64.from(20).toFields(),
			...UInt32.from(9).toFields(),
			...holder.toFields(),
			...otherOuterPk.toFields()
		])
		const wrongHolderDeposit = depositAction([
			...recipient.toFields(),
			...UInt64.from(30).toFields(),
			...UInt32.from(10).toFields(),
			...otherHolder.toFields(),
			...outerPk.toFields()
		])
		const invalidDeposit = depositAction([Field(1), Field(2)])

		const matchedWitness: OuterWitness = {
			action: matchedDeposit.action,
			afterActionState: Field(11),
			beforeActionState: Field(10),
			hash: "witness-hash",
			index: 7,
			slotRange: { lower: UInt32.from(0), upper: UInt32.from(1) },
			timestamp: matchedDeposit.timestamp,
			type: "witness",
			aux: depositAux({
				recipient,
				amount: UInt64.from(10),
				timeout: UInt32.from(5),
				holderAccountL1: holder
			})
		}

		const diagnostics = buildDepositDiagnostics({
			actions: [
				matchedDeposit,
				missingWitnessDeposit,
				wrongOuterDeposit,
				wrongHolderDeposit,
				invalidDeposit
			],
			outerPk,
			outerHolders: [holder],
			witnesses: [matchedWitness]
		})

		expect(diagnostics.map((entry) => entry.status)).toEqual([
			"matched",
			"unmatched",
			"filtered",
			"filtered",
			"filtered"
		])
		expect(diagnostics.map((entry) => entry.reason)).toEqual([
			null,
			"missing-witness",
			"outer-pk-mismatch",
			"holder-account-mismatch",
			"invalid-action-shape"
		])
		expect(diagnostics[0].witness?.index).toBe(7)
	})

	it("classifies withdrawals by witness match status", () => {
		const matchedWithdrawal = withdrawalAction([
			...recipient.toFields(),
			...UInt64.from(15).toFields()
		])
		const invalidWithdrawal = withdrawalAction([Field(1)])
		const missingWitnessWithdrawal = withdrawalAction([
			...recipient.toFields(),
			...UInt64.from(18).toFields()
		])

		const matchedWitness: InnerWitness = {
			action: matchedWithdrawal.action,
			afterActionState: Field(21),
			beforeActionState: Field(20),
			hash: "withdrawal-witness-hash",
			index: 3,
			timestamp: matchedWithdrawal.timestamp,
			aux: withdrawalAux({
				recipient,
				amount: UInt64.from(15)
			})
		}

		const diagnostics = buildWithdrawalDiagnostics({
			actions: [matchedWithdrawal, invalidWithdrawal, missingWitnessWithdrawal],
			witnesses: [matchedWitness]
		})

		expect(diagnostics.map((entry) => entry.status)).toEqual(["matched", "filtered", "unmatched"])
		expect(diagnostics.map((entry) => entry.reason)).toEqual([
			null,
			"invalid-action-shape",
			"missing-witness"
		])
		expect(diagnostics[0].witness?.hash).toBe("withdrawal-witness-hash")
	})

	it("includes graphql errors and validation issues in witness fetch failures", async () => {
		const client = buildGraphqlClient({
			data: { outerWitnessesFromAuxes: [{ aux: 1 }] },
			error: new Error("GraphQL witness failure")
		})

		await expect(fetchOuterWitnessesFromAuxes(client, ["1"])).rejects.toThrow(
			/GraphQL witness failure/
		)
		await expect(fetchOuterWitnessesFromAuxes(client, ["1"])).rejects.toThrow(/Expected string/)
	})

	it("includes graphql errors and validation issues in inner witness fetch failures", async () => {
		const client = buildGraphqlClient({
			data: { innerWitnessesFromAuxes: [{ aux: 1 }] },
			error: new Error("GraphQL inner witness failure")
		})

		await expect(fetchInnerWitnessesFromAuxes(client, ["1"])).rejects.toThrow(
			/GraphQL inner witness failure/
		)
		await expect(fetchInnerWitnessesFromAuxes(client, ["1"])).rejects.toThrow(/Expected string/)
	})

	it("throws instead of silently returning empty actions when the archive query errors", async () => {
		let queryCount = 0
		const client: GqlClient = Object.assign(
			() =>
				({
					query: async () => {
						queryCount += 1

						if (queryCount === 1) {
							return {
								data: { networkState: { maxBlockHeight: { pendingMaxBlockHeight: 25 } } }
							}
						}

						return {
							data: undefined,
							error: new Error("Archive fetch failed")
						}
					}
				}) as unknown as ReturnType<GqlClient>,
			{ label: "test-client" }
		)

		await expect(fetchActions(client, recipient, 0)).rejects.toThrow("Archive fetch failed")
	})
})
