import { Field, UInt32 } from "o1js"
import { describe, expect, it } from "vitest"
import { getSortedDepositWitnesses, type DepositStateContext } from "../src/deposits"
import type { OuterWitness } from "../src/types"

const buildWitness = (index: number): OuterWitness => ({
	action: [Field(index + 1)],
	afterActionState: Field(index + 2),
	beforeActionState: Field(index + 3),
	hash: `witness-${index}`,
	index,
	slotRange: {
		lower: UInt32.zero,
		upper: UInt32.zero
	},
	timestamp: `${index}`,
	type: "witness",
	aux: Field(index + 4)
})

describe("bridge V2 deposit filtering", () => {
	it("excludes pre-V2 deposit witnesses from queue state", () => {
		const witnesses = getSortedDepositWitnesses({
			depositWitnesses: [buildWitness(57_181), buildWitness(70_000), buildWitness(68_520)],
			v2DepositsStartIndex: UInt32.from(68_520)
		} as DepositStateContext)

		expect(witnesses.map(({ index }) => index)).toEqual([68_520, 70_000])
	})
})
