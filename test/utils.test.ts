import { UInt32 } from "o1js"
import { describe, expect, it } from "vitest"
import { bridgeVersionForActionIndex, uint32Max } from "../src/utils"

describe("uint32Max", () => {
	it("returns the larger UInt32 value", () => {
		expect(uint32Max(UInt32.from(1), UInt32.from(3)).toBigint()).toBe(3n)
		expect(uint32Max(UInt32.from(5), UInt32.from(2)).toBigint()).toBe(5n)
	})
})

describe("bridgeVersionForActionIndex", () => {
	it("marks indexes before the v2 start index as bridge version 1", () => {
		expect(
			bridgeVersionForActionIndex({
				actionIndex: 68519,
				v2StartIndex: UInt32.from(68520)
			})
		).toBe(1)
	})

	it("marks indexes at or after the v2 start index as bridge version 2", () => {
		expect(
			bridgeVersionForActionIndex({
				actionIndex: 68520,
				v2StartIndex: UInt32.from(68520)
			})
		).toBe(2)
		expect(
			bridgeVersionForActionIndex({
				actionIndex: 68521,
				v2StartIndex: UInt32.from(68520)
			})
		).toBe(2)
	})

	it("keeps provisional negative indexes on bridge version 2", () => {
		expect(
			bridgeVersionForActionIndex({
				actionIndex: -1,
				v2StartIndex: UInt32.from(10529)
			})
		).toBe(2)
	})
})
